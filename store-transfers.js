(function () {
  "use strict";

  const PHOTO_BUCKET = "photos";
  const state = {
    user: null,
    employee: null,
    stores: [],
    employees: [],
    locations: [],
    items: [],
    currentItem: null,
    sourceParent: null,
    currentSource: null,
    bundle: [],
    evidence: [],
    transfers: [],
    activeReceive: null,
    receiveItem: null,
    receiveParent: null,
    receiveLocation: null,
    itemScanTimer: null,
    sourceScanTimer: null,
    lastAutoItemScan: "",
    itemSearchBusy: false,
    sourceScanBusy: false,
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setStatus(id, message = "", type = "info") {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("is-error", type === "error");
  }

  function waitForSupabase() {
    return new Promise((resolve) => {
      if (window.supabase) return resolve(window.supabase);
      document.addEventListener("supabase-ready", () => resolve(window.supabase), { once: true });
    });
  }

  function gpsSnapshot() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ gps_status: "not_supported" });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          gps_latitude: position.coords.latitude,
          gps_longitude: position.coords.longitude,
          gps_accuracy_meters: position.coords.accuracy,
          gps_captured_at: new Date().toISOString(),
          gps_status: "captured",
        }),
        () => resolve({ gps_status: "denied_or_unavailable" }),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    });
  }

  async function validateEmailPassword(email, password) {
    if (!email || !password) return false;
    const response = await fetch(`${window.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: window.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    return response.ok;
  }

  async function getSignedPhoto(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 60 * 20, {
      transform: { width: 220, height: 220, resize: "cover", quality: 60 },
    });
    return data?.signedUrl || "";
  }

  function employeeLabel(employee) {
    return employee?.display_name || employee?.email || "Unknown user";
  }

  function locationStoreId(location) {
    if (!location) return "";
    const parent = state.locations.find((entry) => String(entry.id) === String(location.parent_location_id));
    return String(location.tray_current_store_id || location.store_id || parent?.store_id || "");
  }

  function locationLabel(location) {
    if (!location) return "Unknown location";
    const parent = state.locations.find((entry) => String(entry.id) === String(location.parent_location_id));
    const role = location.is_tray || location.location_role === "tray"
      ? "Tray"
      : location.parent_location_id
        ? `Container - ${parent?.location_name || "parent"}`
        : "Parent location";
    return `${location.location_name || "Unnamed"} (${location.location_code || "no barcode"}) - ${role}`;
  }

  function findLocationByScan(value) {
    const needle = String(value || "").trim().toLowerCase();
    if (!needle) return null;
    return state.locations.find((location) => {
      const values = [
        location.location_code,
        location.location_name,
        location.type,
      ].map((entry) => String(entry || "").trim().toLowerCase());
      return values.some((entry) => entry === needle);
    }) || state.locations.find((location) => {
      const name = String(location.location_name || "").toLowerCase();
      const code = String(location.location_code || "").toLowerCase();
      return name.includes(needle) || code.includes(needle);
    }) || null;
  }

  function isTray(location) {
    return Boolean(location?.is_tray) || location?.location_role === "tray";
  }

  function isContainer(location) {
    return !isTray(location) && location?.parent_location_id && location?.location_role === "container";
  }

  function isParentLocation(location) {
    return !isTray(location) && !location?.parent_location_id;
  }

  async function loadInitialData() {
    const client = await waitForSupabase();
    const { data: sessionData } = await client.auth.getSession();
    state.user = sessionData?.session?.user || null;
    if (!state.user) {
      window.location.href = "index.html";
      return;
    }

    const [
      employeeResult,
      storesResult,
      receiversResult,
      locationsResult,
    ] = await Promise.all([
      client.from("employees").select("id, user_id, display_name, email, role, active").eq("user_id", state.user.id).maybeSingle(),
      client.from("store_locations").select("id, name, active").eq("active", true).order("name"),
      client.rpc("list_store_transfer_receivers"),
      client.from("locations").select("id, location_name, location_code, type, active, store_id, parent_location_id, location_role, is_tray, tray_current_store_id").eq("active", true).order("location_name"),
    ]);

    state.employee = employeeResult.data || null;
    state.stores = storesResult.data || [];
    state.employees = await resolveReceiverDirectory(client, receiversResult);
    state.locations = locationsResult.data || [];
    if (receiversResult.error) {
      setStatus(
        "create-transfer-status",
        "Receiver directory RPC is not available yet, so the dropdown may only show users visible to this account. Run supabase db push.",
        "error"
      );
    }
    if (window.OGRoleNavigation?.render) {
      window.OGRoleNavigation.render(String(state.employee?.role || "").toLowerCase() === "admin" ? "admin" : "worker");
    }
    renderSelectors();
    await loadTransfers();
    preselectFromUrl();
  }

  async function resolveReceiverDirectory(client, receiversResult) {
    if (!receiversResult.error && Array.isArray(receiversResult.data)) {
      return receiversResult.data
        .filter((employee) => employee.user_id && employee.email)
        .map((employee) => ({
          id: employee.employee_id || employee.id,
          user_id: employee.user_id,
          display_name: employee.display_name || employee.email,
          email: employee.email,
          role: employee.role || "",
          active: true,
        }));
    }

    console.warn("Receiver directory RPC failed, falling back to visible employees:", receiversResult.error);
    const fallback = await client
      .from("employees")
      .select("id, user_id, display_name, email, role, active")
      .not("user_id", "is", null)
      .order("display_name");
    if (fallback.error) {
      console.warn("Receiver fallback lookup failed:", fallback.error);
      return [];
    }
    return (fallback.data || []).filter((employee) => employee.active !== false && employee.user_id && employee.email);
  }

  function renderSelectors() {
    const storeOptions = ['<option value="">Select store</option>']
      .concat(state.stores.map((store) => `<option value="${store.id}">${escapeHtml(store.name)}</option>`))
      .join("");
    $("source-store-select").innerHTML = storeOptions;
    $("destination-store-select").innerHTML = storeOptions;
    $("receiver-user-select").innerHTML = ['<option value="">Select receiving user</option>']
      .concat(state.employees.map((employee) => `<option value="${employee.user_id}" data-email="${escapeHtml(employee.email || "")}">${escapeHtml(employeeLabel(employee))}</option>`))
      .join("");
  }

  async function preselectFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const itemId = params.get("item");
    const ids = params.get("items");
    if (itemId) await selectItemById(itemId);
    if (ids) {
      for (const id of ids.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        await selectItemById(id);
        break;
      }
    }
  }

  async function findItems(value) {
    const needle = String(value || "").trim();
    if (!needle) return [];
    let query = supabase
      .from("item_types")
      .select("id, title, barcode, weight, photos, sale_price")
      .limit(8);
    if (/^og/i.test(needle) || /^\d+$/.test(needle)) {
      query = query.ilike("barcode", needle);
    } else {
      query = query.or(`barcode.ilike.%${needle}%,title.ilike.%${needle}%`);
    }
    let { data, error } = await query;
    if (error && /deleted_at/i.test(error.message || "")) {
      const retry = supabase
        .from("item_types")
        .select("id, title, barcode, weight, photos, sale_price")
        .limit(8);
      query = (/^og/i.test(needle) || /^\d+$/.test(needle))
        ? retry.ilike("barcode", needle)
        : retry.or(`barcode.ilike.%${needle}%,title.ilike.%${needle}%`);
      const result = await query;
      data = result.data;
      error = result.error;
    }
    if (error) throw error;
    return data || [];
  }

  function looksLikeBarcodeScan(value) {
    const text = String(value || "").trim();
    if (text.length < 6 || /\s/.test(text)) return false;
    return /^og/i.test(text) || /^\d{8,}$/.test(text);
  }

  function looksLikeLocationScan(value) {
    const text = String(value || "").trim();
    if (text.length < 4 || /\s/.test(text)) return false;
    return /^loc-/i.test(text) || /^[a-z0-9-]+$/i.test(text);
  }

  async function selectItemById(itemId) {
    const { data, error } = await supabase
      .from("item_types")
      .select("id, title, barcode, weight, photos, sale_price")
      .eq("id", itemId)
      .maybeSingle();
    if (error) throw error;
    if (data) await setCurrentItem(data);
  }

  async function setCurrentItem(item) {
    state.currentItem = item;
    state.currentSource = null;
    state.sourceParent = null;
    const photo = await getSignedPhoto((Array.isArray(item.photos) ? item.photos : [])[0]);
    $("selected-transfer-item").className = `selection-card ${photo ? "has-photo" : ""}`;
    $("selected-transfer-item").innerHTML = `
      ${photo ? `<img class="item-photo" src="${photo}" alt="">` : ""}
      <div>
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <small>${escapeHtml(item.barcode || "")}${item.weight ? ` - ${Number(item.weight).toLocaleString()} g` : ""}</small>
      </div>
    `;
    $("selected-transfer-source").className = "selection-card is-empty";
    $("selected-transfer-source").textContent = "Scan the tray or storage holding this item.";
    setTimeout(() => $("transfer-source-scan")?.focus(), 60);
  }

  async function handleItemSearch(options = {}) {
    const term = $("transfer-item-scan").value.trim();
    if (!term || state.itemSearchBusy) return;
    if (options.auto && state.lastAutoItemScan === term) return;
    state.itemSearchBusy = true;
    try {
      const matches = await findItems(term);
      if (!matches.length) {
        setStatus("create-transfer-status", options.auto ? "" : "No item matched that scan.", options.auto ? "info" : "error");
        return;
      }
      await setCurrentItem(matches[0]);
      if (options.auto) state.lastAutoItemScan = term;
      setStatus("create-transfer-status", matches.length > 1 ? "Multiple matches found; first match selected. Refine if needed." : "Item selected.", "info");
    } catch (error) {
      setStatus("create-transfer-status", error.message || "Could not search items.", "error");
    } finally {
      state.itemSearchBusy = false;
    }
  }

  function scheduleItemAutoSearch() {
    const term = $("transfer-item-scan").value.trim();
    window.clearTimeout(state.itemScanTimer);
    if (!looksLikeBarcodeScan(term)) return;
    state.itemScanTimer = window.setTimeout(() => {
      handleItemSearch({ auto: true });
    }, 450);
  }

  async function fetchStockRowsForCurrentItem() {
    if (!state.currentItem?.id) return [];
    const { data, error } = await supabase
      .from("item_stock_locations")
      .select("id, item_id, location_id, quantity")
      .eq("item_id", state.currentItem.id)
      .gt("quantity", 0);
    if (error) throw error;
    return data || [];
  }

  async function handleSourceScan() {
    if (state.sourceScanBusy) return;
    const sourceStoreId = $("source-store-select").value;
    if (!sourceStoreId) {
      setStatus("create-transfer-status", "Choose the source store first.", "error");
      return;
    }
    if (!state.currentItem) {
      setStatus("create-transfer-status", "Scan an item first.", "error");
      return;
    }
    const rawScan = $("transfer-source-scan").value.trim();
    if (!rawScan) return;
    state.sourceScanBusy = true;
    const location = findLocationByScan(rawScan);
    $("transfer-source-scan").value = "";
    try {
      if (!location) {
        setStatus("create-transfer-status", "No source location matched that scan.", "error");
        return;
      }
      if (locationStoreId(location) !== sourceStoreId) {
        setStatus("create-transfer-status", "That location is not in the selected source store.", "error");
        return;
      }

      if (isParentLocation(location)) {
        state.sourceParent = location;
        state.currentSource = null;
        $("selected-transfer-source").className = "selection-card";
        $("selected-transfer-source").innerHTML = `<strong>Parent confirmed</strong><small>${escapeHtml(locationLabel(location))}. Now scan the bag/container.</small>`;
        setStatus("create-transfer-status", "Parent confirmed. Scan the bag/container that holds this item.", "info");
        setTimeout(() => $("transfer-source-scan")?.focus(), 60);
        return;
      }

      if (isContainer(location) && !state.sourceParent) {
        setStatus("create-transfer-status", "For storage, scan the parent table/vault first, then scan this bag/container.", "error");
        setTimeout(() => $("transfer-source-scan")?.focus(), 60);
        return;
      }

      if (isContainer(location) && String(location.parent_location_id) !== String(state.sourceParent.id)) {
        setStatus("create-transfer-status", "That bag does not belong to the scanned parent location.", "error");
        return;
      }

      if (!isTray(location) && !isContainer(location)) {
        setStatus("create-transfer-status", "Scan a tray or a bag/container that directly holds stock.", "error");
        return;
      }

      const stockRows = await fetchStockRowsForCurrentItem();
      const stockRow = stockRows.find((row) => String(row.location_id) === String(location.id));
      if (!stockRow) {
        setStatus("create-transfer-status", "This item is not available in that source location.", "error");
        return;
      }

      state.currentSource = { location, stockRow };
      const max = Number(stockRow.quantity || 0);
      $("transfer-quantity").max = String(max);
      $("transfer-quantity").value = "1";
      $("selected-transfer-source").className = "selection-card";
      $("selected-transfer-source").innerHTML = `<strong>${escapeHtml(locationLabel(location))}</strong><small>${max.toLocaleString()} unit(s) available.</small>`;
      setStatus("create-transfer-status", "Source selected. Enter the quantity to transfer.", "info");
      setTimeout(() => $("transfer-quantity")?.focus(), 60);
    } finally {
      state.sourceScanBusy = false;
    }
  }

  function scheduleSourceAutoScan() {
    const term = $("transfer-source-scan").value.trim();
    window.clearTimeout(state.sourceScanTimer);
    if (!looksLikeLocationScan(term)) return;
    state.sourceScanTimer = window.setTimeout(() => {
      handleSourceScan();
    }, 350);
  }

  function renderBundle() {
    $("bundle-count-pill").textContent = `${state.bundle.reduce((sum, line) => sum + line.quantity, 0)} units`;
    if (!state.bundle.length) {
      $("transfer-bundle-list").innerHTML = `<div class="empty-state">No merchandise added yet.</div>`;
      return;
    }
    $("transfer-bundle-list").innerHTML = state.bundle.map((line, index) => `
      <article class="bundle-item">
        <div class="bundle-item-top">
          <div>
            <strong>${escapeHtml(line.item.title || "Untitled item")}</strong>
            <small>${escapeHtml(line.item.barcode || "")} - ${escapeHtml(locationLabel(line.location))}</small>
          </div>
          <strong>Qty ${line.quantity}</strong>
        </div>
        <button type="button" class="secondary-btn danger" data-remove-line="${index}">Remove</button>
      </article>
    `).join("");
  }

  function addCurrentLine() {
    if (!state.currentItem || !state.currentSource) {
      setStatus("create-transfer-status", "Select the item and source first.", "error");
      return;
    }
    const qty = Math.trunc(Number($("transfer-quantity").value || 0));
    const available = Number(state.currentSource.stockRow.quantity || 0);
    if (qty <= 0 || qty > available) {
      setStatus("create-transfer-status", `Quantity must be between 1 and ${available}.`, "error");
      return;
    }
    const existing = state.bundle.find((line) => (
      String(line.item.id) === String(state.currentItem.id)
      && String(line.stockRow.id) === String(state.currentSource.stockRow.id)
    ));
    if (existing) existing.quantity += qty;
    else {
      state.bundle.push({
        item: state.currentItem,
        location: state.currentSource.location,
        stockRow: state.currentSource.stockRow,
        quantity: qty,
      });
    }
    state.currentItem = null;
    state.currentSource = null;
    state.sourceParent = null;
    state.lastAutoItemScan = "";
    $("selected-transfer-item").className = "selection-card is-empty";
    $("selected-transfer-item").textContent = "No item selected yet.";
    $("selected-transfer-source").className = "selection-card is-empty";
    $("selected-transfer-source").textContent = "No source selected yet.";
    $("transfer-item-scan").value = "";
    renderBundle();
    setStatus("create-transfer-status", "Added to transfer. Scan another item or press Enter to sign.", "info");
    setTimeout(() => $("transfer-item-scan")?.focus(), 60);
  }

  async function handleEvidenceFiles(files) {
    const list = Array.from(files || []);
    for (const file of list) {
      const extension = String(file.type || "").includes("png") ? "png" : "jpg";
      const path = `store_transfers/evidence-${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, file, {
        upsert: true,
        contentType: file.type || "image/jpeg",
      });
      if (error) {
        setStatus("create-transfer-status", error.message || "Could not upload evidence photo.", "error");
        continue;
      }
      state.evidence.push({ path, url: URL.createObjectURL(file) });
    }
    renderEvidence();
  }

  function renderEvidence() {
    $("transfer-evidence-strip").innerHTML = state.evidence
      .map((photo) => `<img src="${photo.url}" alt="Transfer evidence">`)
      .join("");
  }

  function selectedReceiver() {
    const select = $("receiver-user-select");
    const option = select.options[select.selectedIndex];
    return {
      userId: select.value,
      email: option?.dataset?.email || "",
      label: option?.textContent || "",
    };
  }

  function openSignatureModal() {
    if (!$("source-store-select").value || !$("destination-store-select").value || $("source-store-select").value === $("destination-store-select").value) {
      setStatus("create-transfer-status", "Choose different source and destination stores.", "error");
      return;
    }
    if (!selectedReceiver().userId) {
      setStatus("create-transfer-status", "Choose the receiving user.", "error");
      return;
    }
    if (!state.bundle.length) {
      setStatus("create-transfer-status", "Add at least one item to the transfer.", "error");
      return;
    }
    $("transfer-sign-summary").innerHTML = state.bundle.map((line) => `
      <div><strong>${escapeHtml(line.item.title)}</strong><br><small>Qty ${line.quantity} from ${escapeHtml(locationLabel(line.location))}</small></div>
    `).join("");
    $("sender-password").value = "";
    $("receiver-password").value = "";
    $("transfer-sign-error").textContent = "";
    $("transfer-sign-modal").classList.remove("hidden");
    setTimeout(() => $("sender-password")?.focus(), 60);
  }

  function closeSignatureModal() {
    $("transfer-sign-modal").classList.add("hidden");
  }

  async function submitTransfer() {
    const receiver = selectedReceiver();
    const senderPassword = $("sender-password").value.trim();
    const receiverPassword = $("receiver-password").value.trim();
    if (!senderPassword || !receiverPassword) {
      setStatus("transfer-sign-error", "Both passwords are required.", "error");
      return;
    }
    setStatus("transfer-sign-error", "Verifying signatures...");
    const [senderOk, receiverOk] = await Promise.all([
      validateEmailPassword(state.user.email, senderPassword),
      validateEmailPassword(receiver.email, receiverPassword),
    ]);
    if (!senderOk || !receiverOk) {
      setStatus("transfer-sign-error", senderOk ? "Receiver password is incorrect." : "Sender password is incorrect.", "error");
      return;
    }

    const gps = await gpsSnapshot();
    const payload = {
      _source_store_id: $("source-store-select").value,
      _destination_store_id: $("destination-store-select").value,
      _receiver_user_id: receiver.userId,
      _sender_email: state.user.email,
      _receiver_email: receiver.email,
      _items: state.bundle.map((line) => ({
        item_id: line.item.id,
        source_stock_location_row_id: line.stockRow.id,
        quantity: line.quantity,
      })),
      _evidence_photos: state.evidence.map((photo) => photo.path),
      _notes: $("transfer-notes").value.trim(),
      _gps_latitude: gps.gps_latitude || null,
      _gps_longitude: gps.gps_longitude || null,
      _gps_accuracy_meters: gps.gps_accuracy_meters || null,
      _gps_captured_at: gps.gps_captured_at || null,
      _gps_status: gps.gps_status || "not_requested",
    };
    const { error } = await supabase.rpc("create_store_transfer", payload);
    if (error) {
      setStatus("transfer-sign-error", error.message || "Could not create transfer.", "error");
      return;
    }
    closeSignatureModal();
    clearBundle();
    setStatus("create-transfer-status", "Transfer created and assigned to the receiving user.", "info");
    await loadTransfers();
  }

  function clearBundle() {
    state.bundle = [];
    state.evidence = [];
    state.currentItem = null;
    state.currentSource = null;
    state.sourceParent = null;
    state.lastAutoItemScan = "";
    $("transfer-item-scan").value = "";
    $("transfer-source-scan").value = "";
    $("selected-transfer-item").className = "selection-card is-empty";
    $("selected-transfer-item").textContent = "No item selected yet.";
    $("selected-transfer-source").className = "selection-card is-empty";
    $("selected-transfer-source").textContent = "No source selected yet.";
    renderBundle();
    renderEvidence();
  }

  async function loadTransfers() {
    const { data, error } = await supabase
      .from("store_transfers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(80);
    if (error) {
      $("pending-transfers-list").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      return;
    }
    state.transfers = data || [];
    await renderPendingTransfers();
  }

  function storeName(id) {
    return state.stores.find((store) => String(store.id) === String(id))?.name || "Unknown store";
  }

  async function fetchTransferItems(transferId) {
    const { data, error } = await supabase
      .from("store_transfer_items")
      .select("*, item_types(id,title,barcode,weight,photos), source:locations!store_transfer_items_source_location_id_fkey(id,location_name,location_code,type,store_id,parent_location_id,location_role,is_tray,tray_current_store_id)")
      .eq("transfer_id", transferId)
      .order("created_at");
    if (error) throw error;
    return data || [];
  }

  async function renderPendingTransfers() {
    const filter = $("transfer-status-filter").value;
    let rows = state.transfers;
    if (filter === "open") rows = rows.filter((transfer) => ["pending_receipt", "partially_received", "exception"].includes(transfer.status));
    if (filter === "mine") rows = rows.filter((transfer) => String(transfer.receiver_user_id) === String(state.user?.id) && ["pending_receipt", "partially_received", "exception"].includes(transfer.status));
    if (!rows.length) {
      $("pending-transfers-list").innerHTML = `<div class="empty-state">No transfers match this view.</div>`;
      return;
    }
    $("pending-transfers-list").innerHTML = rows.map((transfer) => `
      <article class="pending-card ${String(transfer.receiver_user_id) === String(state.user?.id) ? "is-mine" : ""}">
        <div class="pending-top">
          <div>
            <strong>${escapeHtml(transfer.transfer_number)}</strong>
            <small>${escapeHtml(storeName(transfer.source_store_id))} to ${escapeHtml(storeName(transfer.destination_store_id))}</small>
          </div>
          <span class="soft-pill">${escapeHtml(transfer.status.replace(/_/g, " "))}</span>
        </div>
        <small>Sender: ${escapeHtml(transfer.sender_email || "-")} - Receiver: ${escapeHtml(transfer.receiver_email || "-")}</small>
        <button type="button" class="primary-btn" data-receive-transfer="${transfer.id}">Open Receiving</button>
      </article>
    `).join("");
  }

  async function openReceiveTransfer(transferId) {
    const transfer = state.transfers.find((entry) => String(entry.id) === String(transferId));
    if (!transfer) return;
    state.activeReceive = transfer;
    state.receiveItem = null;
    state.receiveLocation = null;
    state.receiveParent = null;
    transfer.items = await fetchTransferItems(transferId);
    $("receive-transfer-title").textContent = `${transfer.transfer_number} - ${storeName(transfer.destination_store_id)}`;
    $("receive-transfer-items").innerHTML = transfer.items.map((line) => {
      const remaining = Number(line.quantity_requested || 0) - Number(line.quantity_received || 0);
      return `
        <button type="button" class="receive-line" data-transfer-item="${line.id}" ${remaining <= 0 ? "disabled" : ""}>
          <span class="receive-line-top">
            <strong>${escapeHtml(line.item_types?.title || "Untitled item")}</strong>
            <b>${remaining} left</b>
          </span>
          <small>${escapeHtml(line.item_types?.barcode || "")} - from ${escapeHtml(line.source?.location_name || "source")}</small>
        </button>
      `;
    }).join("");
    $("receive-selected-item").className = "selection-card is-empty";
    $("receive-selected-item").textContent = "No transfer item selected.";
    $("receive-location-card").className = "selection-card is-empty";
    $("receive-location-card").textContent = "No destination selected.";
    $("receive-transfer-modal").classList.remove("hidden");
  }

  function selectReceiveItem(id) {
    const line = state.activeReceive?.items?.find((entry) => String(entry.id) === String(id));
    if (!line) return;
    state.receiveItem = line;
    const remaining = Number(line.quantity_requested || 0) - Number(line.quantity_received || 0);
    $("receive-quantity").max = String(remaining);
    $("receive-quantity").value = String(Math.max(1, remaining));
    $("receive-selected-item").className = "selection-card";
    $("receive-selected-item").innerHTML = `<strong>${escapeHtml(line.item_types?.title || "Untitled item")}</strong><small>${escapeHtml(line.item_types?.barcode || "")} - ${remaining} unit(s) left.</small>`;
    document.querySelectorAll(".receive-line").forEach((button) => button.classList.toggle("is-selected", button.dataset.transferItem === id));
    setTimeout(() => $("receive-location-scan")?.focus(), 60);
  }

  function handleReceiveLocationScan() {
    if (!state.receiveItem) {
      setStatus("receive-transfer-status", "Choose the transfer item first.", "error");
      return;
    }
    const location = findLocationByScan($("receive-location-scan").value);
    $("receive-location-scan").value = "";
    if (!location) {
      setStatus("receive-transfer-status", "No destination location matched that scan.", "error");
      return;
    }
    if (locationStoreId(location) !== String(state.activeReceive.destination_store_id)) {
      setStatus("receive-transfer-status", "That destination is not in this transfer store.", "error");
      return;
    }
    if (isParentLocation(location)) {
      state.receiveParent = location;
      state.receiveLocation = null;
      $("receive-location-card").className = "selection-card";
      $("receive-location-card").innerHTML = `<strong>Parent confirmed</strong><small>${escapeHtml(locationLabel(location))}. Now scan the destination bag/container.</small>`;
      setTimeout(() => $("receive-location-scan")?.focus(), 60);
      return;
    }
    if (isContainer(location) && state.receiveParent && String(location.parent_location_id) !== String(state.receiveParent.id)) {
      setStatus("receive-transfer-status", "That bag does not belong to the scanned parent location.", "error");
      return;
    }
    if (!isTray(location) && !isContainer(location)) {
      setStatus("receive-transfer-status", "Scan a tray or bag/container that can hold stock.", "error");
      return;
    }
    state.receiveLocation = location;
    $("receive-location-card").className = "selection-card";
    $("receive-location-card").innerHTML = `<strong>${escapeHtml(locationLabel(location))}</strong><small>Destination confirmed.</small>`;
    setTimeout(() => $("receive-quantity")?.focus(), 60);
  }

  async function submitReceive() {
    if (!state.activeReceive || !state.receiveItem || !state.receiveLocation) {
      setStatus("receive-transfer-status", "Choose item and destination first.", "error");
      return;
    }
    const password = $("receive-password").value.trim();
    if (!password) {
      setStatus("receive-transfer-status", "Password is required.", "error");
      return;
    }
    if (!await validateEmailPassword(state.user.email, password)) {
      setStatus("receive-transfer-status", "Incorrect password.", "error");
      return;
    }
    const qty = Math.trunc(Number($("receive-quantity").value || 0));
    const gps = await gpsSnapshot();
    const { error } = await supabase.rpc("receive_store_transfer_items", {
      _transfer_id: state.activeReceive.id,
      _placements: [{
        transfer_item_id: state.receiveItem.id,
        destination_location_id: state.receiveLocation.id,
        quantity: qty,
      }],
      _signed_by_email: state.user.email,
      _notes: $("receive-notes").value.trim(),
      _gps_latitude: gps.gps_latitude || null,
      _gps_longitude: gps.gps_longitude || null,
      _gps_accuracy_meters: gps.gps_accuracy_meters || null,
      _gps_captured_at: gps.gps_captured_at || null,
      _gps_status: gps.gps_status || "not_requested",
    });
    if (error) {
      setStatus("receive-transfer-status", error.message || "Could not receive transfer.", "error");
      return;
    }
    setStatus("receive-transfer-status", "Placement recorded.");
    $("receive-password").value = "";
    await loadTransfers();
    await openReceiveTransfer(state.activeReceive.id);
  }

  async function markException() {
    if (!state.activeReceive) return;
    const note = $("receive-notes").value.trim();
    if (!note) {
      setStatus("receive-transfer-status", "Add a note explaining the exception.", "error");
      return;
    }
    const gps = await gpsSnapshot();
    const { error } = await supabase.rpc("mark_store_transfer_exception", {
      _transfer_id: state.activeReceive.id,
      _transfer_item_id: state.receiveItem?.id || null,
      _notes: note,
      _signed_by_email: state.user.email,
      _gps_latitude: gps.gps_latitude || null,
      _gps_longitude: gps.gps_longitude || null,
      _gps_accuracy_meters: gps.gps_accuracy_meters || null,
      _gps_captured_at: gps.gps_captured_at || null,
      _gps_status: gps.gps_status || "not_requested",
    });
    if (error) {
      setStatus("receive-transfer-status", error.message || "Could not mark exception.", "error");
      return;
    }
    $("receive-transfer-modal").classList.add("hidden");
    await loadTransfers();
  }

  function bindEvents() {
    $("find-transfer-item").addEventListener("click", handleItemSearch);
    $("transfer-item-scan").addEventListener("input", () => {
      state.lastAutoItemScan = "";
      scheduleItemAutoSearch();
    });
    $("transfer-item-scan").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(state.itemScanTimer);
        handleItemSearch();
      }
    });
    $("find-transfer-source").addEventListener("click", handleSourceScan);
    $("transfer-source-scan").addEventListener("input", scheduleSourceAutoScan);
    $("transfer-source-scan").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(state.sourceScanTimer);
        handleSourceScan();
      }
    });
    $("transfer-quantity").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addCurrentLine();
      }
    });
    $("add-transfer-line").addEventListener("click", addCurrentLine);
    $("transfer-evidence-input").addEventListener("change", (event) => handleEvidenceFiles(event.target.files));
    $("transfer-bundle-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-line]");
      if (!button) return;
      state.bundle.splice(Number(button.dataset.removeLine), 1);
      renderBundle();
    });
    $("clear-transfer-bundle").addEventListener("click", clearBundle);
    $("open-transfer-signature").addEventListener("click", openSignatureModal);
    $("close-transfer-sign").addEventListener("click", closeSignatureModal);
    $("cancel-transfer-sign").addEventListener("click", closeSignatureModal);
    $("submit-transfer").addEventListener("click", submitTransfer);
    $("refresh-transfers").addEventListener("click", loadTransfers);
    $("transfer-status-filter").addEventListener("change", renderPendingTransfers);
    $("pending-transfers-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-receive-transfer]");
      if (button) openReceiveTransfer(button.dataset.receiveTransfer);
    });
    $("receive-transfer-items").addEventListener("click", (event) => {
      const button = event.target.closest("[data-transfer-item]");
      if (button) selectReceiveItem(button.dataset.transferItem);
    });
    $("find-receive-location").addEventListener("click", handleReceiveLocationScan);
    $("receive-location-scan").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleReceiveLocationScan();
      }
    });
    $("receive-quantity").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $("receive-password").focus();
      }
    });
    $("submit-receive-transfer").addEventListener("click", submitReceive);
    $("mark-transfer-exception").addEventListener("click", markException);
    $("close-receive-transfer").addEventListener("click", () => $("receive-transfer-modal").classList.add("hidden"));
    document.addEventListener("keydown", (event) => {
      if (event.key === " " && !event.target.matches("input, textarea, select")) {
        event.preventDefault();
        $("transfer-item-scan")?.focus();
      }
      if (event.key === "Enter" && !event.target.matches("input, textarea, select") && state.bundle.length) {
        event.preventDefault();
        openSignatureModal();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    renderBundle();
    await loadInitialData();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  });
})();
