/* ================= Storage and Tray Transfer Module ================= */
window.storageTransferModule = (function () {
  const MODE_STORAGE_TO_TRAY = "storage_to_tray";
  const MODE_TRAY_TO_STORAGE = "tray_to_storage";

  const state = {
    initialized: false,
    mode: MODE_STORAGE_TO_TRAY,
    locations: [],
    stores: [],
    forwardItemCandidates: [],
    parent: null,
    containers: [],
    stockRows: [],
    itemsById: new Map(),
    selectedContainer: null,
    selectedStockRow: null,
    selectedItem: null,
    selectedTray: null,
    trayConflict: null,
    returnItemCandidates: [],
    returnTrayRows: [],
    returnSelectedStockRow: null,
    returnSelectedItem: null,
    returnSelectedTray: null,
    returnContainer: null,
    returnParent: null,
    autoTimers: new Map(),
    busy: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeScan(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getStatusElement() {
    return $(state.mode === MODE_TRAY_TO_STORAGE ? "return-transfer-status" : "storage-transfer-status");
  }

  function setStatus(message, tone = "") {
    const status = getStatusElement();
    if (!status) return;
    status.textContent = message || "";
    status.dataset.tone = tone;
  }

  function showModuleToast(message, type = "info") {
    if (typeof showToast === "function") {
      showToast(message, type);
    } else {
      setStatus(message, type);
    }
  }

  function focusAndSelect(id, delay = 50) {
    window.setTimeout(() => {
      const input = $(id);
      input?.focus();
      input?.select?.();
    }, delay);
  }

  function clearAutoTimer(key) {
    const current = state.autoTimers.get(key);
    if (current) window.clearTimeout(current);
    state.autoTimers.delete(key);
  }

  function scheduleAutoAction(key, input, handler, waitMs = 1000) {
    clearAutoTimer(key);
    const value = input?.value || "";
    if (!String(value).trim()) return;
    const timer = window.setTimeout(() => {
      if ((input?.value || "") === value) handler();
    }, waitMs);
    state.autoTimers.set(key, timer);
  }

  function scheduleReviewIfReady(key = "auto-review") {
    clearAutoTimer(key);
    const validation = state.mode === MODE_TRAY_TO_STORAGE
      ? validateReturnReadyForReview()
      : validateReadyForReview();
    if (validation) return;
    const timer = window.setTimeout(() => {
      const nextValidation = state.mode === MODE_TRAY_TO_STORAGE
        ? validateReturnReadyForReview()
        : validateReadyForReview();
      if (!nextValidation) openConfirmModal();
    }, 1000);
    state.autoTimers.set(key, timer);
  }

  function getLocationRole(location) {
    if (!location) return "";
    if (location.is_tray) return "tray";
    if (location.location_role) return String(location.location_role);
    return location.parent_location_id ? "container" : "storage_location";
  }

  function isTray(location) {
    return getLocationRole(location) === "tray";
  }

  function isContainer(location) {
    return getLocationRole(location) === "container";
  }

  function getStoreName(storeId) {
    return state.stores.find((store) => store.id === storeId)?.name || "";
  }

  function getLocationStoreId(location) {
    if (!location) return "";
    if (isTray(location)) return location.tray_current_store_id || location.store_id || "";
    if (isContainer(location)) {
      const parent = state.locations.find((entry) => entry.id === location.parent_location_id);
      return parent?.store_id || location.store_id || "";
    }
    return location.store_id || "";
  }

  function getLocationPath(location) {
    if (!location) return "Unknown location";
    const storeName = getStoreName(getLocationStoreId(location)) || "Unassigned";

    if (isTray(location)) {
      const status = location.tray_status ? String(location.tray_status).replace(/_/g, " ") : "checked in";
      return `${storeName} > ${location.location_name || "Unnamed tray"} (${status})`;
    }

    if (isContainer(location)) {
      const parent = state.locations.find((entry) => entry.id === location.parent_location_id);
      return `${storeName} > ${parent?.location_name || "Parent location"} > ${location.location_name || "Unnamed container"}`;
    }

    return `${storeName} > ${location.location_name || "Unnamed location"}`;
  }

  function getItemPhoto(item) {
    const photos = Array.isArray(item?.photos) ? item.photos : [];
    const photoPaths = Array.isArray(item?.photoPaths) ? item.photoPaths : [];
    const first = photos.find(Boolean) || photoPaths.find(Boolean) || item?.photo_url || "";
    if (!first) return "";
    if (/^https?:\/\//i.test(first)) return first;
    return first;
  }

  async function getItemPhotoUrl(item) {
    const path = getItemPhoto(item);
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    if (typeof getSignedUrl === "function") {
      return await getSignedUrl(path);
    }
    try {
      const { data, error } = await supabase.storage.from("photos").createSignedUrl(path, 3600);
      if (!error && data?.signedUrl) return data.signedUrl;
    } catch (_) {}
    return "";
  }

  function openItemPhotoPreview(url, title = "Item photo") {
    const modal = $("storage-transfer-photo-modal");
    const image = $("storage-transfer-photo-preview");
    const caption = $("storage-transfer-photo-caption");
    if (!modal || !image || !url) return;
    image.src = url;
    image.alt = title;
    if (caption) caption.textContent = title;
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    focusAndSelect("close-storage-transfer-photo", 40);
  }

  function closeItemPhotoPreview() {
    const modal = $("storage-transfer-photo-modal");
    const image = $("storage-transfer-photo-preview");
    if (image) image.src = "";
    modal?.classList.add("hidden");
    if (!$("storage-transfer-modal")?.classList.contains("hidden")) {
      document.body.classList.add("modal-open");
    } else {
      document.body.classList.remove("modal-open");
    }
  }

  function setMode(mode) {
    state.mode = mode === MODE_TRAY_TO_STORAGE ? MODE_TRAY_TO_STORAGE : MODE_STORAGE_TO_TRAY;
    document.querySelectorAll("[data-storage-transfer-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.storageTransferMode === state.mode);
    });

    $("storage-transfer-forward-flow")?.classList.toggle("hidden", state.mode !== MODE_STORAGE_TO_TRAY);
    $("storage-transfer-return-flow")?.classList.toggle("hidden", state.mode !== MODE_TRAY_TO_STORAGE);

    const eyebrow = $("storage-transfer-eyebrow");
    const title = $("storage-transfer-title");
    const subtitle = $("storage-transfer-subtitle");
    if (state.mode === MODE_TRAY_TO_STORAGE) {
      if (eyebrow) eyebrow.textContent = "Tray to storage";
      if (title) title.textContent = "Return Tray Stock";
      if (subtitle) subtitle.textContent = "Scan the item, confirm the tray source, scan the destination bag and parent location, then sign the return.";
      focusAndSelect("return-transfer-item-scan", 75);
    } else {
      if (eyebrow) eyebrow.textContent = "Storage to tray";
      if (title) title.textContent = "Replenish Tray";
      if (subtitle) subtitle.textContent = "Confirm the item, scan the parent location, scan the bag that contains it, scan the tray, then sign the transfer.";
      if (state.selectedItem) focusAndSelect("storage-transfer-parent-scan", 75);
      else focusAndSelect("storage-transfer-item-scan", 75);
    }
    setStatus("");
  }

  function resetForwardSelection({ keepTray = true, keepItem = false } = {}) {
    state.selectedStockRow = null;
    state.selectedContainer = null;
    if (!keepItem) {
      state.forwardItemCandidates = [];
      state.selectedItem = null;
    }
    state.trayConflict = null;
    if (!keepTray) state.selectedTray = null;
    const qty = $("storage-transfer-quantity");
    if (qty) {
      qty.value = "1";
      qty.removeAttribute("max");
    }
    renderForwardItemSummary();
    renderContainerSummary();
    renderSelectedItem();
    renderTraySummary();
  }

  function resetReturnSelection({ keepDestination = true } = {}) {
    state.returnItemCandidates = [];
    state.returnTrayRows = [];
    state.returnSelectedStockRow = null;
    state.returnSelectedItem = null;
    state.returnSelectedTray = null;
    if (!keepDestination) {
      state.returnContainer = null;
      state.returnParent = null;
    }
    const qty = $("return-transfer-quantity");
    if (qty) {
      qty.value = "1";
      qty.removeAttribute("max");
    }
    renderReturnItemSummary();
    renderReturnDestinationSummaries();
    renderReturnTrayOptions();
    renderReturnSelectedCard();
  }

  async function loadLocations() {
    const [{ data: locations, error: locationsError }, { data: stores, error: storesError }] = await Promise.all([
      supabase.from("locations").select("*").eq("active", true),
      supabase.from("store_locations").select("id, name, active"),
    ]);

    if (locationsError) throw locationsError;
    if (storesError) throw storesError;

    state.locations = Array.isArray(locations) ? locations : [];
    state.stores = Array.isArray(stores) ? stores : [];
  }

  function findLocationByScan(query, predicate) {
    const normalized = normalizeScan(query);
    if (!normalized) return null;

    const candidates = state.locations.filter((location) => !predicate || predicate(location));
    const exact = candidates.find((location) => {
      return [location.location_code, location.location_name]
        .some((value) => normalizeScan(value) === normalized);
    });
    if (exact) return exact;

    return candidates.find((location) => {
      return [location.location_code, location.location_name, getLocationPath(location)]
        .some((value) => normalizeScan(value).includes(normalized));
    }) || null;
  }

  async function findItemCandidates(query) {
    const value = String(query || "").trim();
    if (!value) return [];

    const { data: exactRows, error: exactError } = await supabase
      .from("item_types")
      .select("id, title, barcode, weight, sale_price, photos, photo_url")
      .eq("barcode", value)
      .limit(8);

    if (exactError) throw exactError;
    if (exactRows?.length) return exactRows;

    const search = value.replace(/[%_]/g, "").trim();
    if (search.length < 2) return [];

    const { data: titleRows, error: titleError } = await supabase
      .from("item_types")
      .select("id, title, barcode, weight, sale_price, photos, photo_url")
      .or(`title.ilike.%${search}%,barcode.ilike.%${search}%`)
      .limit(8);

    if (titleError) throw titleError;
    return titleRows || [];
  }

  function renderForwardItemSummary() {
    const target = $("storage-transfer-item-summary");
    const results = $("storage-transfer-item-results");
    if (!target) return;

    if (!state.selectedItem) {
      target.className = "storage-transfer-summary-card is-empty";
      target.textContent = state.forwardItemCandidates.length
        ? "Choose the matching item below."
        : "No item selected.";
      if (results) {
        results.innerHTML = state.forwardItemCandidates.length
          ? state.forwardItemCandidates.map((item) => `
            <button type="button" class="storage-transfer-item-row" data-forward-item-id="${escapeHtml(item.id)}">
              <span>
                <strong>${escapeHtml(item.title || "Untitled item")}</strong>
                <small>${escapeHtml(item.barcode || "No barcode")}</small>
              </span>
              <b>Select</b>
            </button>
          `).join("")
          : "";
      }
      return;
    }

    target.className = "storage-transfer-summary-card storage-transfer-item-summary-card";
    target.innerHTML = `
      <button type="button" class="storage-transfer-item-photo-btn" data-transfer-item-photo>
        <span>No photo</span>
      </button>
      <div>
        <span>Item to replenish</span>
        <strong>${escapeHtml(state.selectedItem.title || "Untitled item")}</strong>
        <small>${escapeHtml(state.selectedItem.barcode || "No barcode")}</small>
      </div>
    `;
    if (results) results.innerHTML = "";

    const photoButton = target.querySelector("[data-transfer-item-photo]");
    const itemForPhoto = state.selectedItem;
    target.dataset.itemId = itemForPhoto.id || "";
    getItemPhotoUrl(itemForPhoto).then((url) => {
      if (!url || !photoButton || itemForPhoto.id !== photoButton.closest("#storage-transfer-item-summary")?.dataset.itemId) return;
      photoButton.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(itemForPhoto.title || "Item photo")}">`;
      photoButton.dataset.photoUrl = url;
      photoButton.title = "Open item photo";
    }).catch((error) => {
      console.warn("Could not load replenish item photo:", error);
    });
  }

  async function selectForwardItem(item, options = {}) {
    state.selectedItem = item;
    state.forwardItemCandidates = [];
    state.selectedStockRow = null;
    state.selectedContainer = null;
    state.trayConflict = null;
    renderForwardItemSummary();
    renderContainerSummary();
    renderSelectedItem();
    renderBags();

    if (state.selectedTray) {
      try {
        await checkTrayConflict();
      } catch (error) {
        console.error("Tray conflict check failed:", error);
        setStatus(error?.message || "Could not check tray conflicts.", "error");
      }
    }

    if (!options.silentFocus) focusAndSelect("storage-transfer-parent-scan");
  }

  async function handleForwardItemScan() {
    clearAutoTimer("forward-item-scan");
    const input = $("storage-transfer-item-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      const candidates = await findItemCandidates(query);
      if (!candidates.length) throw new Error("No item matched that barcode or title.");

      state.forwardItemCandidates = candidates;
      state.selectedItem = null;
      state.selectedStockRow = null;
      state.selectedContainer = null;
      renderForwardItemSummary();
      renderContainerSummary();
      renderSelectedItem();
      renderBags();

      if (candidates.length === 1) {
        await selectForwardItem(candidates[0]);
      } else {
        setStatus("Choose the matching item, then continue scanning the storage location.", "info");
        $("storage-transfer-item-results")?.querySelector("[data-forward-item-id]")?.focus?.();
      }
    } catch (error) {
      console.error("Forward item scan failed:", error);
      resetForwardSelection({ keepTray: true, keepItem: false });
      setStatus(error?.message || "Could not find that item.", "error");
      showModuleToast(error?.message || "Could not find that item.", "error");
      focusAndSelect("storage-transfer-item-scan");
    }
  }

  function renderParentSummary() {
    const target = $("storage-transfer-parent-summary");
    if (!target) return;

    if (!state.parent) {
      target.className = "storage-transfer-summary-card is-empty";
      target.textContent = "No parent location selected.";
      return;
    }

    target.className = "storage-transfer-summary-card";
    target.innerHTML = `
      <span>Source parent</span>
      <strong>${escapeHtml(state.parent.location_name || "Unnamed location")}</strong>
      <small>${escapeHtml(state.parent.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.parent))}</small>
    `;
  }

  function renderContainerSummary() {
    const target = $("storage-transfer-container-summary");
    if (!target) return;

    if (!state.selectedContainer) {
      target.className = "storage-transfer-summary-card is-empty";
      target.textContent = "No bag selected.";
      return;
    }

    const quantity = Number(state.selectedStockRow?.quantity || 0);
    target.className = "storage-transfer-summary-card";
    target.innerHTML = `
      <span>Source bag</span>
      <strong>${escapeHtml(state.selectedContainer.location_name || "Unnamed bag")}</strong>
      <small>${escapeHtml(state.selectedContainer.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.selectedContainer))}</small>
      <div class="storage-transfer-selected-meta">
        <b>${quantity.toLocaleString()} available</b>
        <span>${escapeHtml(state.selectedItem?.title || "Selected item")}</span>
      </div>
    `;
  }

  function renderTraySummary() {
    const target = $("storage-transfer-tray-summary");
    if (!target) return;

    if (!state.selectedTray) {
      target.className = "storage-transfer-summary-card is-empty";
      target.textContent = "No tray selected.";
      return;
    }

    const conflictMarkup = state.trayConflict ? `
      <div class="storage-transfer-alert">
        This item is already in ${escapeHtml(state.trayConflict.location_name || "another tray")}
        (${escapeHtml(state.trayConflict.location_code || "no barcode")}) in this store.
      </div>
    ` : "";

    target.className = `storage-transfer-summary-card ${state.trayConflict ? "has-error" : ""}`;
    target.innerHTML = `
      <span>Destination tray</span>
      <strong>${escapeHtml(state.selectedTray.location_name || "Unnamed tray")}</strong>
      <small>${escapeHtml(state.selectedTray.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.selectedTray))}</small>
      ${conflictMarkup}
    `;
  }

  function renderSelectedItem() {
    const target = $("storage-transfer-selected-item");
    const hint = $("storage-transfer-quantity-hint");
    const status = $("storage-transfer-selection-status");
    if (!target) return;

    if (!state.selectedStockRow || !state.selectedItem) {
      target.className = "storage-transfer-selected-card is-empty";
      target.textContent = state.selectedItem
        ? "Scan the bag/container that contains this item."
        : "No item selected.";
      if (hint) hint.textContent = "Available quantity will appear after selecting an item.";
      if (status) status.textContent = state.selectedItem
        ? "Scan the source bag that contains the selected item."
        : "Scan or search for the item first.";
      return;
    }

    const quantity = Number(state.selectedStockRow.quantity || 0);
    const container = state.selectedContainer || state.containers.find((location) => location.id === state.selectedStockRow.location_id);
    const qtyInput = $("storage-transfer-quantity");
    if (qtyInput) {
      qtyInput.max = String(quantity);
      if (!qtyInput.value || Number(qtyInput.value) <= 0) qtyInput.value = "1";
    }

    target.className = "storage-transfer-selected-card";
    target.innerHTML = `
      <span>Selected item</span>
      <strong>${escapeHtml(state.selectedItem.title || "Untitled item")}</strong>
      <small>${escapeHtml(state.selectedItem.barcode || "No barcode")}</small>
      <div class="storage-transfer-selected-meta">
        <b>${escapeHtml(container?.location_name || "Selected bag")}</b>
        <span>${quantity.toLocaleString()} available</span>
      </div>
    `;
    if (hint) hint.textContent = `Maximum available from this bag: ${quantity.toLocaleString()}.`;
    if (status) status.textContent = `${state.selectedItem.title || "Item"} selected.`;
  }

  function renderBags() {
    const target = $("storage-transfer-bags");
    const status = $("storage-transfer-bags-status");
    if (!target) return;

    if (!state.parent) {
      target.innerHTML = `<div class="storage-transfer-empty">Confirm the item, then scan a table, vault, or parent storage location.</div>`;
      if (status) status.textContent = state.selectedItem
        ? "Scan a parent location to load bags that may contain this item."
        : "Confirm an item first.";
      return;
    }

    if (!state.containers.length) {
      target.innerHTML = `<div class="storage-transfer-empty">No bags or containers are assigned to this parent location yet.</div>`;
      if (status) status.textContent = "No bags found.";
      return;
    }

    const rowsByContainer = new Map();
    state.stockRows.forEach((row) => {
      if (!rowsByContainer.has(row.location_id)) rowsByContainer.set(row.location_id, []);
      rowsByContainer.get(row.location_id).push(row);
    });

    if (status) {
      const itemCount = state.stockRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
      status.textContent = state.selectedItem
        ? `${state.containers.length} bag(s), ${itemCount.toLocaleString()} total matching unit(s) for this item.`
        : `${state.containers.length} bag(s), ${itemCount.toLocaleString()} total unit(s).`;
    }

    target.innerHTML = state.containers.map((container) => {
      const rows = rowsByContainer.get(container.id) || [];
      return `
        <article class="storage-transfer-bag-card">
          <div class="storage-transfer-bag-head">
            <div>
              <span>${escapeHtml(container.container_kind || container.type || "Container")}</span>
              <strong>${escapeHtml(container.location_name || "Unnamed bag")}</strong>
              <small>${escapeHtml(container.location_code || "No barcode")}</small>
            </div>
            <b>${rows.length.toLocaleString()} item type(s)</b>
          </div>
          <div class="storage-transfer-item-list">
            ${rows.length ? rows.map((row) => {
              const item = state.itemsById.get(row.item_id) || {};
              const selected = state.selectedStockRow?.id === row.id;
              return `
                <button type="button" class="storage-transfer-item-row ${selected ? "is-selected" : ""}" data-source-stock-id="${escapeHtml(row.id)}">
                  <span>
                    <strong>${escapeHtml(item.title || "Untitled item")}</strong>
                    <small>${escapeHtml(item.barcode || "No barcode")}</small>
                  </span>
                  <b>Qty ${Number(row.quantity || 0).toLocaleString()}</b>
                </button>
              `;
            }).join("") : `<div class="storage-transfer-empty is-small">${state.selectedItem ? "This item is not in this bag." : "No active stock in this bag."}</div>`}
          </div>
        </article>
      `;
    }).join("");
  }

  async function loadParentContainers(parent) {
    state.parent = parent;
    state.containers = state.locations
      .filter((location) => location.parent_location_id === parent.id && isContainer(location) && location.active !== false)
      .sort((a, b) => String(a.location_name || "").localeCompare(String(b.location_name || "")));
    state.stockRows = [];
    state.itemsById = new Map();
    resetForwardSelection({ keepTray: true, keepItem: true });
    renderParentSummary();

    if (!state.containers.length) {
      renderBags();
      return;
    }

    const containerIds = state.containers.map((location) => location.id);
    const { data: stockRows, error: stockError } = await supabase
      .from("item_stock_locations")
      .select("id, item_id, quantity, location_id, locked_by, locked_at")
      .in("location_id", containerIds)
      .gt("quantity", 0);

    if (stockError) throw stockError;

    state.stockRows = Array.isArray(stockRows) ? stockRows : [];
    if (state.selectedItem?.id) {
      state.stockRows = state.stockRows.filter((row) => row.item_id === state.selectedItem.id);
    }
    const itemIds = [...new Set(state.stockRows.map((row) => row.item_id).filter(Boolean))];

    if (itemIds.length) {
      const { data: items, error: itemsError } = await supabase
        .from("item_types")
        .select("id, title, barcode, weight, sale_price, photos, photo_url")
        .in("id", itemIds);
      if (itemsError) throw itemsError;
      state.itemsById = new Map((items || []).map((item) => [item.id, item]));
    }

    renderBags();
  }

  async function handleParentScan() {
    clearAutoTimer("forward-parent-scan");
    const input = $("storage-transfer-parent-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      if (!state.selectedItem) {
        focusAndSelect("storage-transfer-item-scan");
        throw new Error("Confirm the item before scanning the storage location.");
      }
      await loadLocations();
      const parent = findLocationByScan(query, (location) => {
        return !isTray(location) && !isContainer(location) && location.active !== false;
      });

      if (!parent) throw new Error("No active parent location matched that scan.");

      await loadParentContainers(parent);
      focusAndSelect("storage-transfer-container-scan");
    } catch (error) {
      console.error("Parent scan failed:", error);
      setStatus(error?.message || "Could not load that parent location.", "error");
      showModuleToast(error?.message || "Could not load that parent location.", "error");
    }
  }

  async function handleContainerScan() {
    clearAutoTimer("forward-container-scan");
    const input = $("storage-transfer-container-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      if (!state.selectedItem) {
        focusAndSelect("storage-transfer-item-scan");
        throw new Error("Confirm the item before scanning a bag.");
      }
      if (!state.parent) {
        focusAndSelect("storage-transfer-parent-scan");
        throw new Error("Scan the parent table, vault, or storage location before scanning the bag.");
      }
      if (!state.locations.length) await loadLocations();

      const container = findLocationByScan(query, (location) => {
        return isContainer(location)
          && location.active !== false
          && location.parent_location_id === state.parent.id;
      });
      if (!container) throw new Error("No active bag under the selected parent matched that scan.");

      const row = state.stockRows.find((entry) => (
        entry.location_id === container.id
        && entry.item_id === state.selectedItem.id
        && Number(entry.quantity || 0) > 0
      ));
      if (!row) {
        state.selectedContainer = null;
        state.selectedStockRow = null;
        renderContainerSummary();
        renderSelectedItem();
        throw new Error("That bag does not contain the selected item, so it cannot be used for this transfer.");
      }

      state.selectedContainer = container;
      await selectSourceStockRow(row.id, { keepFocus: true });
      renderContainerSummary();

      if (!state.selectedTray) focusAndSelect("storage-transfer-tray-scan");
      else {
        focusAndSelect("storage-transfer-quantity");
        scheduleReviewIfReady("storage-to-tray-quantity-ready");
      }
    } catch (error) {
      console.error("Container scan failed:", error);
      setStatus(error?.message || "Could not select that bag.", "error");
      showModuleToast(error?.message || "Could not select that bag.", "error");
    }
  }

  async function checkTrayConflict() {
    state.trayConflict = null;
    if (!state.selectedTray || !state.selectedItem) {
      renderTraySummary();
      return null;
    }

    const targetStoreId = getLocationStoreId(state.selectedTray);
    const { data, error } = await supabase
      .from("item_stock_locations")
      .select("id, quantity, location:location_id (*)")
      .eq("item_id", state.selectedItem.id)
      .gt("quantity", 0);

    if (error) throw error;

    const conflict = (data || []).find((row) => {
      const location = row.location;
      return location
        && isTray(location)
        && location.id !== state.selectedTray.id
        && (location.tray_current_store_id || location.store_id || "") === targetStoreId;
    });

    state.trayConflict = conflict?.location || null;
    renderTraySummary();
    return state.trayConflict;
  }

  async function handleTrayScan() {
    clearAutoTimer("forward-tray-scan");
    const input = $("storage-transfer-tray-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      if (!state.selectedItem) {
        focusAndSelect("storage-transfer-item-scan");
        throw new Error("Confirm the item before scanning the tray.");
      }
      if (!state.selectedStockRow || !state.selectedContainer) {
        focusAndSelect("storage-transfer-container-scan");
        throw new Error("Scan the source bag that contains the selected item before scanning the tray.");
      }
      if (!state.locations.length) await loadLocations();
      const tray = findLocationByScan(query, (location) => isTray(location) && location.active !== false);
      if (!tray) throw new Error("No active tray matched that scan.");

      if (state.parent) {
        const parentStoreId = getLocationStoreId(state.parent);
        const trayStoreId = getLocationStoreId(tray);
        if (parentStoreId && trayStoreId && parentStoreId !== trayStoreId) {
          throw new Error("That tray is not checked into the same store as the scanned storage location.");
        }
      }

      state.selectedTray = tray;
      await checkTrayConflict();
      focusAndSelect("storage-transfer-quantity");
      scheduleReviewIfReady("storage-to-tray-quantity-ready");
    } catch (error) {
      console.error("Tray scan failed:", error);
      state.selectedTray = null;
      state.trayConflict = null;
      renderTraySummary();
      setStatus(error?.message || "Could not select that tray.", "error");
      showModuleToast(error?.message || "Could not select that tray.", "error");
    }
  }

  async function selectSourceStockRow(stockRowId, options = {}) {
    const row = state.stockRows.find((entry) => entry.id === stockRowId);
    if (!row) return;

    state.selectedStockRow = row;
    state.selectedItem = state.itemsById.get(row.item_id) || null;
    state.selectedContainer = state.containers.find((location) => location.id === row.location_id) || null;
    renderForwardItemSummary();
    renderContainerSummary();
    renderSelectedItem();
    renderBags();

    try {
      await checkTrayConflict();
    } catch (error) {
      console.error("Tray conflict check failed:", error);
      setStatus(error?.message || "Could not check tray conflicts.", "error");
    }

    if (options.keepFocus) {
      return;
    }

    if (!state.selectedTray) {
      focusAndSelect("storage-transfer-tray-scan");
    } else {
      focusAndSelect("storage-transfer-quantity");
      scheduleReviewIfReady("storage-to-tray-quantity-ready");
    }
  }

  function validateReadyForReview() {
    if (!state.selectedItem) return "Confirm the item barcode or title first.";
    if (!state.parent) return "Scan the parent table, vault, or storage location first.";
    if (!state.selectedContainer) return "Scan the source bag or container.";
    if (!state.selectedStockRow) return "The selected bag does not contain this item.";
    if (!state.selectedTray) return "Scan the destination tray.";
    if (state.trayConflict) return "This item is already in another tray in this store.";

    const qty = Number.parseInt($("storage-transfer-quantity")?.value || "0", 10);
    const available = Number(state.selectedStockRow.quantity || 0);
    if (!Number.isFinite(qty) || qty <= 0) return "Enter a quantity greater than zero.";
    if (qty > available) return `Only ${available.toLocaleString()} unit(s) are available in that bag.`;
    return "";
  }

  function renderReturnItemSummary() {
    const target = $("return-transfer-item-summary");
    if (!target) return;

    if (!state.returnSelectedItem) {
      target.className = "storage-transfer-summary-card is-empty";
      target.textContent = state.returnItemCandidates.length
        ? "Choose the matching item below."
        : "No item selected.";
      return;
    }

    target.className = "storage-transfer-summary-card";
    target.innerHTML = `
      <span>Item to return</span>
      <strong>${escapeHtml(state.returnSelectedItem.title || "Untitled item")}</strong>
      <small>${escapeHtml(state.returnSelectedItem.barcode || "No barcode")}</small>
    `;
  }

  function renderReturnDestinationSummaries() {
    const bagTarget = $("return-transfer-bag-summary");
    const parentTarget = $("return-transfer-parent-summary");

    if (bagTarget) {
      if (!state.returnContainer) {
        bagTarget.className = "storage-transfer-summary-card is-empty";
        bagTarget.textContent = "No destination bag selected.";
      } else {
        bagTarget.className = "storage-transfer-summary-card";
        bagTarget.innerHTML = `
          <span>Destination bag</span>
          <strong>${escapeHtml(state.returnContainer.location_name || "Unnamed bag")}</strong>
          <small>${escapeHtml(state.returnContainer.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.returnContainer))}</small>
        `;
      }
    }

    if (parentTarget) {
      if (!state.returnParent) {
        parentTarget.className = "storage-transfer-summary-card is-empty";
        parentTarget.textContent = "No parent location selected.";
      } else {
        parentTarget.className = "storage-transfer-summary-card";
        parentTarget.innerHTML = `
          <span>Destination parent</span>
          <strong>${escapeHtml(state.returnParent.location_name || "Unnamed location")}</strong>
          <small>${escapeHtml(state.returnParent.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.returnParent))}</small>
        `;
      }
    }
  }

  function renderReturnTrayOptions() {
    const target = $("return-transfer-tray-options");
    const status = $("return-transfer-tray-status");
    if (!target) return;

    if (state.returnItemCandidates.length && !state.returnSelectedItem) {
      if (status) status.textContent = `${state.returnItemCandidates.length} possible item match(es).`;
      target.innerHTML = state.returnItemCandidates.map((item) => `
        <button type="button" class="storage-transfer-item-row" data-return-item-id="${escapeHtml(item.id)}">
          <span>
            <strong>${escapeHtml(item.title || "Untitled item")}</strong>
            <small>${escapeHtml(item.barcode || "No barcode")}</small>
          </span>
          <b>Select</b>
        </button>
      `).join("");
      return;
    }

    if (!state.returnSelectedItem) {
      target.innerHTML = `<div class="storage-transfer-empty">Scan an item label first. The tray that currently has it will appear here.</div>`;
      if (status) status.textContent = "Scan an item to find the tray that has it.";
      return;
    }

    if (!state.returnTrayRows.length) {
      target.innerHTML = `<div class="storage-transfer-empty">This item is not currently recorded in any active tray.</div>`;
      if (status) status.textContent = "No tray stock found for this item.";
      return;
    }

    if (status) {
      const total = state.returnTrayRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
      status.textContent = `${state.returnTrayRows.length} tray source(s), ${total.toLocaleString()} unit(s) available.`;
    }

    target.innerHTML = state.returnTrayRows.map((row) => {
      const selected = state.returnSelectedStockRow?.id === row.id;
      const tray = row.location || {};
      return `
        <button type="button" class="storage-transfer-item-row ${selected ? "is-selected" : ""}" data-return-tray-stock-id="${escapeHtml(row.id)}">
          <span>
            <strong>${escapeHtml(tray.location_name || "Unnamed tray")}</strong>
            <small>${escapeHtml(tray.location_code || "No barcode")} - ${escapeHtml(getLocationPath(tray))}</small>
          </span>
          <b>Qty ${Number(row.quantity || 0).toLocaleString()}</b>
        </button>
      `;
    }).join("");
  }

  function renderReturnSelectedCard() {
    const target = $("return-transfer-selected-card");
    const hint = $("return-transfer-quantity-hint");
    const status = $("return-transfer-selection-status");
    if (!target) return;

    if (!state.returnSelectedItem || !state.returnSelectedStockRow || !state.returnSelectedTray) {
      target.className = "storage-transfer-selected-card is-empty";
      target.textContent = "No return source selected.";
      if (hint) hint.textContent = "Available quantity will appear after selecting the tray.";
      if (status) status.textContent = "Scan the item first.";
      return;
    }

    const quantity = Number(state.returnSelectedStockRow.quantity || 0);
    const qtyInput = $("return-transfer-quantity");
    if (qtyInput) {
      qtyInput.max = String(quantity);
      if (!qtyInput.value || Number(qtyInput.value) <= 0) qtyInput.value = "1";
    }

    target.className = "storage-transfer-selected-card";
    target.innerHTML = `
      <span>Returning from tray</span>
      <strong>${escapeHtml(state.returnSelectedItem.title || "Untitled item")}</strong>
      <small>${escapeHtml(state.returnSelectedItem.barcode || "No barcode")}</small>
      <div class="storage-transfer-selected-meta">
        <b>${escapeHtml(state.returnSelectedTray.location_name || "Selected tray")}</b>
        <span>${quantity.toLocaleString()} available</span>
      </div>
    `;
    if (hint) hint.textContent = `Maximum available from this tray: ${quantity.toLocaleString()}.`;
    if (status) status.textContent = "Tray source selected.";
  }

  async function loadReturnTrayRowsForItem(item) {
    state.returnTrayRows = [];
    state.returnSelectedStockRow = null;
    state.returnSelectedTray = null;
    renderReturnSelectedCard();

    const { data, error } = await supabase
      .from("item_stock_locations")
      .select("id, item_id, quantity, location_id, locked_by, locked_at, location:location_id (*)")
      .eq("item_id", item.id)
      .gt("quantity", 0);

    if (error) throw error;

    state.returnTrayRows = (data || [])
      .filter((row) => row.location && isTray(row.location) && row.location.active !== false)
      .sort((a, b) => String(a.location?.location_name || "").localeCompare(String(b.location?.location_name || "")));

    renderReturnTrayOptions();
    if (state.returnTrayRows.length === 1) {
      selectReturnTrayStockRow(state.returnTrayRows[0].id);
    }
  }

  async function selectReturnItem(item) {
    state.returnSelectedItem = item;
    state.returnItemCandidates = [];
    renderReturnItemSummary();
    await loadReturnTrayRowsForItem(item);
    if (!state.returnSelectedTray) {
      const firstTrayButton = $("return-transfer-tray-options")?.querySelector("[data-return-tray-stock-id]");
      firstTrayButton?.focus?.();
    }
  }

  function selectReturnTrayStockRow(stockRowId) {
    const row = state.returnTrayRows.find((entry) => entry.id === stockRowId);
    if (!row) return;

    state.returnSelectedStockRow = row;
    state.returnSelectedTray = row.location || null;
    renderReturnTrayOptions();
    renderReturnSelectedCard();

    if (!state.returnContainer) {
      focusAndSelect("return-transfer-bag-scan");
    } else if (!state.returnParent) {
      focusAndSelect("return-transfer-parent-scan");
    } else {
      focusAndSelect("return-transfer-quantity");
      scheduleReviewIfReady("return-quantity-ready");
    }
  }

  async function handleReturnItemScan() {
    clearAutoTimer("return-item-scan");
    const input = $("return-transfer-item-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      await loadLocations();
      const candidates = await findItemCandidates(query);
      if (!candidates.length) throw new Error("No item matched that barcode or title.");

      state.returnItemCandidates = candidates;
      state.returnSelectedItem = null;
      state.returnTrayRows = [];
      state.returnSelectedStockRow = null;
      state.returnSelectedTray = null;
      renderReturnItemSummary();
      renderReturnTrayOptions();
      renderReturnSelectedCard();

      if (candidates.length === 1) {
        await selectReturnItem(candidates[0]);
      } else {
        setStatus("Choose the matching item from the source tray list.", "info");
      }
    } catch (error) {
      console.error("Return item scan failed:", error);
      resetReturnSelection({ keepDestination: true });
      setStatus(error?.message || "Could not find that item.", "error");
      showModuleToast(error?.message || "Could not find that item.", "error");
    }
  }

  function validateReturnDestinationPair() {
    if (state.returnContainer && state.returnParent && state.returnContainer.parent_location_id !== state.returnParent.id) {
      throw new Error("The scanned bag does not belong to the scanned parent location.");
    }

    if (state.returnSelectedTray && state.returnParent) {
      const trayStoreId = getLocationStoreId(state.returnSelectedTray);
      const parentStoreId = getLocationStoreId(state.returnParent);
      if (trayStoreId && parentStoreId && trayStoreId !== parentStoreId) {
        throw new Error("The destination storage location is not in the same store as the tray.");
      }
    }
  }

  async function handleReturnBagScan() {
    clearAutoTimer("return-bag-scan");
    const input = $("return-transfer-bag-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      if (!state.locations.length) await loadLocations();
      const container = findLocationByScan(query, (location) => isContainer(location) && location.active !== false);
      if (!container) throw new Error("No active bag or container matched that scan.");

      state.returnContainer = container;
      validateReturnDestinationPair();
      renderReturnDestinationSummaries();

      if (!state.returnParent) {
        focusAndSelect("return-transfer-parent-scan");
      } else {
        focusAndSelect("return-transfer-quantity");
        scheduleReviewIfReady("return-quantity-ready");
      }
    } catch (error) {
      console.error("Return bag scan failed:", error);
      state.returnContainer = null;
      renderReturnDestinationSummaries();
      setStatus(error?.message || "Could not select that bag.", "error");
      showModuleToast(error?.message || "Could not select that bag.", "error");
    }
  }

  async function handleReturnParentScan() {
    clearAutoTimer("return-parent-scan");
    const input = $("return-transfer-parent-scan");
    const query = input?.value || "";
    setStatus("");

    try {
      if (!state.locations.length) await loadLocations();
      const parent = findLocationByScan(query, (location) => {
        return !isTray(location) && !isContainer(location) && location.active !== false;
      });
      if (!parent) throw new Error("No active parent location matched that scan.");

      state.returnParent = parent;
      validateReturnDestinationPair();
      renderReturnDestinationSummaries();
      focusAndSelect("return-transfer-quantity");
      scheduleReviewIfReady("return-quantity-ready");
    } catch (error) {
      console.error("Return parent scan failed:", error);
      state.returnParent = null;
      renderReturnDestinationSummaries();
      setStatus(error?.message || "Could not select that parent location.", "error");
      showModuleToast(error?.message || "Could not select that parent location.", "error");
    }
  }

  function validateReturnReadyForReview() {
    if (!state.returnSelectedItem) return "Scan the item label first.";
    if (!state.returnSelectedStockRow || !state.returnSelectedTray) return "Select the tray that currently has this item.";
    if (!state.returnContainer) return "Scan the destination bag or container.";
    if (!state.returnParent) return "Scan the parent table, vault, or storage location.";

    try {
      validateReturnDestinationPair();
    } catch (error) {
      return error.message;
    }

    const qty = Number.parseInt($("return-transfer-quantity")?.value || "0", 10);
    const available = Number(state.returnSelectedStockRow.quantity || 0);
    if (!Number.isFinite(qty) || qty <= 0) return "Enter a quantity greater than zero.";
    if (qty > available) return `Only ${available.toLocaleString()} unit(s) are available in that tray.`;
    return "";
  }

  function getForwardConfirmMarkup(qty) {
    const sourceContainer = state.selectedContainer || state.containers.find((location) => location.id === state.selectedStockRow.location_id);
    return `
      <div>
        <span>From bag</span>
        <strong>${escapeHtml(sourceContainer?.location_name || "Selected bag")}</strong>
        <small>${escapeHtml(sourceContainer?.location_code || "No barcode")} - ${escapeHtml(getLocationPath(sourceContainer))}</small>
      </div>
      <div>
        <span>To tray</span>
        <strong>${escapeHtml(state.selectedTray.location_name || "Selected tray")}</strong>
        <small>${escapeHtml(state.selectedTray.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.selectedTray))}</small>
      </div>
      <div>
        <span>Item</span>
        <strong>${escapeHtml(state.selectedItem.title || "Untitled item")}</strong>
        <small>${escapeHtml(state.selectedItem.barcode || "No barcode")}</small>
      </div>
      <div>
        <span>Quantity</span>
        <strong>${qty.toLocaleString()}</strong>
        <small>Available in bag: ${Number(state.selectedStockRow.quantity || 0).toLocaleString()}</small>
      </div>
    `;
  }

  function getReturnConfirmMarkup(qty) {
    return `
      <div>
        <span>From tray</span>
        <strong>${escapeHtml(state.returnSelectedTray.location_name || "Selected tray")}</strong>
        <small>${escapeHtml(state.returnSelectedTray.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.returnSelectedTray))}</small>
      </div>
      <div>
        <span>To bag</span>
        <strong>${escapeHtml(state.returnContainer.location_name || "Selected bag")}</strong>
        <small>${escapeHtml(state.returnContainer.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.returnContainer))}</small>
      </div>
      <div>
        <span>Parent location</span>
        <strong>${escapeHtml(state.returnParent.location_name || "Selected location")}</strong>
        <small>${escapeHtml(state.returnParent.location_code || "No barcode")} - ${escapeHtml(getLocationPath(state.returnParent))}</small>
      </div>
      <div>
        <span>Item and quantity</span>
        <strong>${escapeHtml(state.returnSelectedItem.title || "Untitled item")}</strong>
        <small>${escapeHtml(state.returnSelectedItem.barcode || "No barcode")} - ${qty.toLocaleString()} unit(s)</small>
      </div>
    `;
  }

  function openConfirmModal() {
    clearAutoTimer("auto-review");
    clearAutoTimer("storage-to-tray-quantity-ready");
    clearAutoTimer("return-quantity-ready");
    clearAutoTimer("forward-quantity-review");
    clearAutoTimer("return-quantity-review");
    clearAutoTimer("forward-quantity-focus");
    clearAutoTimer("return-quantity-focus");

    const validation = state.mode === MODE_TRAY_TO_STORAGE
      ? validateReturnReadyForReview()
      : validateReadyForReview();
    if (validation) {
      setStatus(validation, "error");
      showModuleToast(validation, "error");
      return;
    }

    const qtyInputId = state.mode === MODE_TRAY_TO_STORAGE ? "return-transfer-quantity" : "storage-transfer-quantity";
    const qty = Number.parseInt($(qtyInputId)?.value || "0", 10);
    const summary = $("storage-transfer-confirm-summary");
    const password = $("storage-transfer-password");
    const error = $("storage-transfer-confirm-error");
    const modal = $("storage-transfer-confirm-modal");
    const eyebrow = $("storage-transfer-confirm-eyebrow");
    const title = $("storage-transfer-confirm-title");

    if (summary) {
      summary.innerHTML = state.mode === MODE_TRAY_TO_STORAGE
        ? getReturnConfirmMarkup(qty)
        : getForwardConfirmMarkup(qty);
    }
    if (eyebrow) eyebrow.textContent = state.mode === MODE_TRAY_TO_STORAGE ? "Signed tray return" : "Signed replenishment";
    if (title) title.textContent = state.mode === MODE_TRAY_TO_STORAGE ? "Confirm Tray Return" : "Confirm Tray Replenishment";
    if (password) password.value = "";
    if (error) error.textContent = "";
    modal?.classList.remove("hidden");
    document.body.classList.add("modal-open");
    focusAndSelect("storage-transfer-password", 75);
  }

  function closeConfirmModal() {
    $("storage-transfer-confirm-modal")?.classList.add("hidden");
    if ($("storage-transfer-modal")?.classList.contains("hidden")) {
      document.body.classList.remove("modal-open");
    }
  }

  async function confirmStorageToTray(userEmail) {
    const qty = Number.parseInt($("storage-transfer-quantity")?.value || "0", 10);
    const notes = $("storage-transfer-notes")?.value || "";
    const validation = validateReadyForReview();
    if (validation) throw new Error(validation);

    const { data, error } = await supabase.rpc("transfer_container_stock_to_tray", {
      _source_stock_row_id: state.selectedStockRow.id,
      _destination_tray_location_id: state.selectedTray.id,
      _quantity: qty,
      _signed_by_email: userEmail,
      _notes: notes,
    });

    if (error) throw error;

    const changedItemId = state.selectedItem.id;
    await bumpInventoryVersion?.([changedItemId]);
    if (typeof refreshItemById === "function") await refreshItemById(changedItemId);

    const parent = state.parent;
    resetForwardSelection({ keepTray: true, keepItem: false });
    if ($("storage-transfer-item-scan")) $("storage-transfer-item-scan").value = "";
    if ($("storage-transfer-container-scan")) $("storage-transfer-container-scan").value = "";
    if (parent) await loadParentContainers(parent);
    renderTraySummary();
    focusAndSelect("storage-transfer-item-scan");
    console.log("Storage to tray transfer result:", data);
    return changedItemId;
  }

  async function confirmTrayToStorage(userEmail) {
    const qty = Number.parseInt($("return-transfer-quantity")?.value || "0", 10);
    const notes = $("return-transfer-notes")?.value || "";
    const validation = validateReturnReadyForReview();
    if (validation) throw new Error(validation);

    const { data, error } = await supabase.rpc("transfer_tray_stock_to_container", {
      _source_stock_row_id: state.returnSelectedStockRow.id,
      _destination_container_location_id: state.returnContainer.id,
      _parent_location_id: state.returnParent.id,
      _quantity: qty,
      _signed_by_email: userEmail,
      _notes: notes,
    });

    if (error) throw error;

    const changedItemId = state.returnSelectedItem.id;
    await bumpInventoryVersion?.([changedItemId]);
    if (typeof refreshItemById === "function") await refreshItemById(changedItemId);

    resetReturnSelection({ keepDestination: true });
    focusAndSelect("return-transfer-item-scan");
    console.log("Tray to storage transfer result:", data);
    return changedItemId;
  }

  async function confirmTransfer() {
    if (state.busy) return;
    const errorEl = $("storage-transfer-confirm-error");
    const password = $("storage-transfer-password")?.value || "";

    if (!password.trim()) {
      if (errorEl) errorEl.textContent = "Password is required to sign this transfer.";
      return;
    }

    try {
      state.busy = true;
      if (errorEl) errorEl.textContent = "";

      if (!window.checkoutModule?.verifyPasswordForCurrentUser) {
        throw new Error("Password verification is not available on this page.");
      }

      const valid = await window.checkoutModule.verifyPasswordForCurrentUser(password.trim());
      if (!valid) {
        if (errorEl) errorEl.textContent = "Incorrect password. Please try again.";
        return;
      }

      const { data: userResult, error: userError } = await supabase.auth.getUser();
      if (userError || !userResult?.user) throw new Error("Could not authenticate this transfer.");

      if (state.mode === MODE_TRAY_TO_STORAGE) {
        await confirmTrayToStorage(userResult.user.email || "");
        closeConfirmModal();
        showModuleToast("Tray return recorded.", "success");
        setStatus("Transfer complete. The tray and destination bag quantities were updated.", "success");
      } else {
        await confirmStorageToTray(userResult.user.email || "");
        closeConfirmModal();
        showModuleToast("Tray replenishment recorded.", "success");
        setStatus("Transfer complete. The bag and tray quantities were updated.", "success");
      }
    } catch (error) {
      console.error("Storage transfer failed:", error);
      if (errorEl) errorEl.textContent = error?.message || "Transfer failed.";
      setStatus(error?.message || "Transfer failed.", "error");
    } finally {
      state.busy = false;
    }
  }

  function openModal() {
    const modal = $("storage-transfer-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    setStatus("");
    if (state.mode === MODE_STORAGE_TO_TRAY) {
      state.parent = null;
      state.containers = [];
      state.stockRows = [];
      state.itemsById = new Map();
      resetForwardSelection({ keepTray: false, keepItem: false });
      ["storage-transfer-item-scan", "storage-transfer-parent-scan", "storage-transfer-container-scan", "storage-transfer-tray-scan"].forEach((id) => {
        const input = $(id);
        if (input) input.value = "";
      });
      renderParentSummary();
      renderBags();
    }
    loadLocations()
      .catch((error) => {
        console.error("Failed to preload transfer locations:", error);
        setStatus("Could not preload locations. You can still try scanning.", "error");
      })
      .finally(() => {
        setMode(state.mode);
      });
  }

  async function openForItem(itemId) {
    const modal = $("storage-transfer-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    state.parent = null;
    state.containers = [];
    state.stockRows = [];
    state.itemsById = new Map();
    state.selectedTray = null;
    state.selectedContainer = null;
    state.selectedStockRow = null;
    state.trayConflict = null;
    ["storage-transfer-parent-scan", "storage-transfer-container-scan", "storage-transfer-tray-scan"].forEach((id) => {
      const input = $(id);
      if (input) input.value = "";
    });
    renderParentSummary();
    renderContainerSummary();
    renderTraySummary();
    renderBags();
    setMode(MODE_STORAGE_TO_TRAY);
    setStatus("");

    try {
      await loadLocations();
      let item = typeof window.getStockItemById === "function" ? window.getStockItemById(itemId) : null;
      if (!item) {
        const { data, error } = await supabase
          .from("item_types")
          .select("id, title, barcode, weight, sale_price, photos, photo_url")
          .eq("id", itemId)
          .maybeSingle();
        if (error) throw error;
        item = data;
      }
      if (!item) throw new Error("Could not load that item for replenishment.");

      const input = $("storage-transfer-item-scan");
      if (input) input.value = item.barcode || item.title || "";
      await selectForwardItem(item);
      setStatus("Item confirmed. Scan the parent table/vault/location barcode.", "success");
    } catch (error) {
      console.error("Could not open replenish flow for item:", error);
      setStatus(error?.message || "Could not start replenishment for that item.", "error");
      showModuleToast(error?.message || "Could not start replenishment for that item.", "error");
      focusAndSelect("storage-transfer-item-scan");
    }
  }

  function closeModal() {
    $("storage-transfer-modal")?.classList.add("hidden");
    $("storage-transfer-confirm-modal")?.classList.add("hidden");
    document.body.classList.remove("modal-open");
  }

  function bindEnter(id, handler) {
    $(id)?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      handler();
    });
  }

  function bindDebouncedInput(id, key, handler) {
    const input = $(id);
    input?.addEventListener("input", () => scheduleAutoAction(key, input, handler));
  }

  function bindEvents() {
    $("open-storage-transfer")?.addEventListener("click", openModal);
    $("close-storage-transfer")?.addEventListener("click", closeModal);
    $("storage-transfer-find-item")?.addEventListener("click", handleForwardItemScan);
    $("storage-transfer-find-parent")?.addEventListener("click", handleParentScan);
    $("storage-transfer-find-container")?.addEventListener("click", handleContainerScan);
    $("storage-transfer-find-tray")?.addEventListener("click", handleTrayScan);
    $("storage-transfer-review-btn")?.addEventListener("click", openConfirmModal);
    $("return-transfer-find-item")?.addEventListener("click", handleReturnItemScan);
    $("return-transfer-find-bag")?.addEventListener("click", handleReturnBagScan);
    $("return-transfer-find-parent")?.addEventListener("click", handleReturnParentScan);
    $("return-transfer-review-btn")?.addEventListener("click", openConfirmModal);
    $("close-storage-transfer-confirm")?.addEventListener("click", closeConfirmModal);
    $("cancel-storage-transfer-confirm")?.addEventListener("click", closeConfirmModal);
    $("confirm-storage-transfer")?.addEventListener("click", confirmTransfer);

    document.querySelectorAll("[data-storage-transfer-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.storageTransferMode));
    });

    bindEnter("storage-transfer-item-scan", handleForwardItemScan);
    bindEnter("storage-transfer-parent-scan", handleParentScan);
    bindEnter("storage-transfer-container-scan", handleContainerScan);
    bindEnter("storage-transfer-tray-scan", handleTrayScan);
    bindEnter("storage-transfer-quantity", openConfirmModal);
    bindEnter("return-transfer-item-scan", handleReturnItemScan);
    bindEnter("return-transfer-bag-scan", handleReturnBagScan);
    bindEnter("return-transfer-parent-scan", handleReturnParentScan);
    bindEnter("return-transfer-quantity", openConfirmModal);
    bindEnter("storage-transfer-password", confirmTransfer);

    bindDebouncedInput("storage-transfer-item-scan", "forward-item-scan", handleForwardItemScan);
    bindDebouncedInput("storage-transfer-parent-scan", "forward-parent-scan", handleParentScan);
    bindDebouncedInput("storage-transfer-container-scan", "forward-container-scan", handleContainerScan);
    bindDebouncedInput("storage-transfer-tray-scan", "forward-tray-scan", handleTrayScan);
    bindDebouncedInput("return-transfer-item-scan", "return-item-scan", handleReturnItemScan);
    bindDebouncedInput("return-transfer-bag-scan", "return-bag-scan", handleReturnBagScan);
    bindDebouncedInput("return-transfer-parent-scan", "return-parent-scan", handleReturnParentScan);

    $("storage-transfer-quantity")?.addEventListener("input", () => scheduleReviewIfReady("forward-quantity-review"));
    $("return-transfer-quantity")?.addEventListener("input", () => scheduleReviewIfReady("return-quantity-review"));
    $("return-transfer-quantity")?.addEventListener("focus", () => scheduleReviewIfReady("return-quantity-focus"));
    $("storage-transfer-quantity")?.addEventListener("focus", () => scheduleReviewIfReady("forward-quantity-focus"));

    $("storage-transfer-bags")?.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-source-stock-id]");
      if (!trigger) return;
      selectSourceStockRow(trigger.getAttribute("data-source-stock-id"));
    });

    $("storage-transfer-item-summary")?.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-transfer-item-photo]");
      if (!trigger) return;
      const url = trigger.dataset.photoUrl;
      if (!url) return;
      openItemPhotoPreview(url, state.selectedItem?.title || "Item photo");
    });

    $("storage-transfer-item-results")?.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-forward-item-id]");
      if (!trigger) return;
      const item = state.forwardItemCandidates.find((entry) => entry.id === trigger.getAttribute("data-forward-item-id"));
      if (item) await selectForwardItem(item);
    });

    $("return-transfer-tray-options")?.addEventListener("click", async (event) => {
      const itemTrigger = event.target.closest("[data-return-item-id]");
      if (itemTrigger) {
        const item = state.returnItemCandidates.find((entry) => entry.id === itemTrigger.getAttribute("data-return-item-id"));
        if (item) await selectReturnItem(item);
        return;
      }

      const trayTrigger = event.target.closest("[data-return-tray-stock-id]");
      if (trayTrigger) selectReturnTrayStockRow(trayTrigger.getAttribute("data-return-tray-stock-id"));
    });

    $("storage-transfer-modal")?.addEventListener("click", (event) => {
      if (event.target.id === "storage-transfer-modal") closeModal();
    });

    $("storage-transfer-confirm-modal")?.addEventListener("click", (event) => {
      if (event.target.id === "storage-transfer-confirm-modal") closeConfirmModal();
    });

    $("close-storage-transfer-photo")?.addEventListener("click", closeItemPhotoPreview);
    $("storage-transfer-photo-modal")?.addEventListener("click", (event) => {
      if (event.target.id === "storage-transfer-photo-modal") closeItemPhotoPreview();
    });
  }

  function setup() {
    if (state.initialized) return;
    state.initialized = true;
    bindEvents();
    renderParentSummary();
    renderForwardItemSummary();
    renderContainerSummary();
    renderTraySummary();
    renderSelectedItem();
    renderBags();
    renderReturnItemSummary();
    renderReturnDestinationSummaries();
    renderReturnTrayOptions();
    renderReturnSelectedCard();
    setMode(MODE_STORAGE_TO_TRAY);

    if (window.location.hash === "#replenish-tray") {
      window.setTimeout(openModal, 250);
    }
  }

  return {
    setup,
    openModal,
    openForItem,
  };
})();
