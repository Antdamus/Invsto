/* ================= Transfer Stock Module ================= */
window.transferModule = (function () {
    let currentItem = null; // 📦 stores item being transferred
    let maxTransferQty = 0; // 🚦 max quantity at selected source
    let currentLockedSourceId = null; // 🛡️ Track locked source location ID


    // 🚪 Open the transfer modal for a specific item ID
    const TRAY_STATUS_LABELS = {
        checked_in: "Checked In",
        checked_out: "Checked Out",
        in_transfer: "In Transfer",
        weight_mismatch: "Weight Mismatch",
    };

    function formatTransferLocation(location, storeMap = {}) {
        if (!location) return { title: "Unknown location", meta: "", isTray: false };
        const homeStore = storeMap[location.store_id] || storeMap[location.parent_store_id] || "Unassigned";
        const currentStore = storeMap[location.tray_current_store_id] || homeStore;
        const isTray = Boolean(location.is_tray);
        const isContainer = Boolean(location.parent_location_id) && !isTray;
        return {
            title: location.location_name || "Unknown location",
            meta: isTray
                ? `Tray - ${TRAY_STATUS_LABELS[location.tray_status] || "Tray"} - Current: ${currentStore}`
                : isContainer
                    ? `Container - ${location.parent_location_name || "parent location"} - ${homeStore}`
                    : homeStore,
            isTray,
            isContainer,
        };
    }

    function escapeTransferHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function ensureTransferModalLayout() {
        const modalContent = document.querySelector("#transfer-modal .modal-content");
        if (!modalContent || modalContent.querySelector(".transfer-v2")) return;
        modalContent.classList.add("transfer-v2-content");

        modalContent.innerHTML = `
            <button type="button" class="transfer-v2-close" id="close-transfer-modal" title="Close" aria-label="Close">&times;</button>
            <header class="transfer-v2-head">
                <div>
                    <p class="transfer-v2-kicker">Inventory Movement</p>
                    <h2 class="modal-header">Transfer Stock</h2>
                    <p class="modal-subtext">Move inventory between locations and review the receiving tray before confirming.</p>
                </div>
            </header>

            <div class="transfer-v2">
                <aside class="transfer-v2-item">
                    <div class="transfer-v2-photo">
                        <img id="transfer-item-image" class="transfer-item-image" src="" alt="Item Preview" />
                    </div>
                    <div class="transfer-v2-item-copy">
                        <span>Item</span>
                        <strong id="transfer-item-title">Loading...</strong>
                    </div>
                    <section class="transfer-v2-stock-card">
                        <div class="transfer-v2-section-label">Current Stock</div>
                        <ul id="transfer-stock-breakdown" class="transfer-stock-list"></ul>
                    </section>
                </aside>

                <section class="transfer-v2-workflow">
                    <div class="transfer-v2-fields">
                        <div class="modal-input-section">
                            <label for="transfer-source-location">Source Location</label>
                            <select id="transfer-source-location">
                                <option value="">Choose Source</option>
                            </select>
                        </div>

                        <div class="modal-input-section">
                            <label for="transfer-destination-location">Destination Location</label>
                            <select id="transfer-destination-location">
                                <option value="">Choose Destination</option>
                            </select>
                        </div>

                        <div class="modal-input-section transfer-quantity-section">
                            <label for="transfer-quantity">Quantity</label>
                            <div class="transfer-qty-wrapper">
                                <input type="number" id="transfer-quantity" min="1" placeholder="1" />
                                <span class="transfer-max-info">Max <span id="transfer-max-qty">0</span></span>
                            </div>
                        </div>
                    </div>

                    <p id="transfer-dest-current-stock" class="transfer-current-stock hidden"></p>
                    <section id="transfer-location-intelligence" class="transfer-intelligence-panel is-empty">
                        <div class="transfer-intelligence-empty">Select a destination tray or location to review its contents and similar-weight items.</div>
                    </section>
                </section>
            </div>

            <footer class="modal-actions transfer-v2-actions">
                <p id="transfer-error-message" class="error-message"></p>
                <div>
                    <button id="cancel-transfer-btn" class="cancel-btn" title="Cancel transfer">Cancel</button>
                    <button id="confirm-transfer-btn" class="confirm-btn" title="Confirm transfer">Confirm Transfer</button>
                </div>
            </footer>
        `;
    }

    function formatTransferWeight(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "--";
        return `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })} g`;
    }

    function getCurrentItemWeight() {
        const weight = Number(currentItem?.weight || 0);
        return Number.isFinite(weight) ? weight : 0;
    }

    function setTransferIntelligenceEmpty(message = "Select a destination tray or location to review its contents and similar-weight items.") {
        const panel = document.getElementById("transfer-location-intelligence");
        if (!panel) return;
        panel.className = "transfer-intelligence-panel is-empty";
        panel.innerHTML = `<div class="transfer-intelligence-empty">${escapeTransferHtml(message)}</div>`;
    }

    async function renderTransferLocationIntelligence(locationId, label = "Selected Location") {
        const panel = document.getElementById("transfer-location-intelligence");
        if (!panel) return;

        if (!locationId) {
            setTransferIntelligenceEmpty();
            return;
        }

        panel.className = "transfer-intelligence-panel is-loading";
        panel.innerHTML = `<div class="transfer-intelligence-empty">Loading ${escapeTransferHtml(label.toLowerCase())} contents...</div>`;

        try {
            const storeMap = await fetchTransferStores();
            const [
                { data: location, error: locationError },
                { data: stockRows, error: stockError },
            ] = await Promise.all([
                supabase
                    .from("locations")
                    .select("*")
                    .eq("id", locationId)
                    .maybeSingle(),
                supabase
                    .from("item_stock_locations")
                    .select("item_id, quantity")
                    .eq("location_id", locationId)
                    .eq("condition_status", "good")
                    .gt("quantity", 0),
            ]);

            if (locationError) throw locationError;
            if (stockError) throw stockError;

            const itemIds = [...new Set((stockRows || []).map((row) => row.item_id).filter(Boolean))];
            let itemMap = {};
            if (itemIds.length) {
                const { data: items, error: itemsError } = await supabase
                    .from("item_types")
                    .select("id, title, barcode, weight")
                    .in("id", itemIds);
                if (itemsError) throw itemsError;
                itemMap = Object.fromEntries((items || []).map((item) => [item.id, item]));
            }

            const rows = (stockRows || []).map((row) => {
                const item = itemMap[row.item_id] || {};
                const weight = Number(item.weight || 0);
                const quantity = Number(row.quantity || 0);
                const delta = Math.abs(weight - getCurrentItemWeight());
                return {
                    itemId: row.item_id,
                    title: item.title || "Untitled item",
                    barcode: item.barcode || "",
                    weight,
                    quantity,
                    delta,
                    isSimilar: row.item_id !== currentItem?.id && Number.isFinite(delta) && delta <= 2,
                };
            });

            const locationLabel = formatTransferLocation(location, storeMap);
            const totalUnits = rows.reduce((sum, row) => sum + row.quantity, 0);
            const totalWeight = rows.reduce((sum, row) => sum + (Number.isFinite(row.weight) ? row.weight * row.quantity : 0), 0);
            const similarRows = rows.filter((row) => row.isSimilar);
            const similarUnits = similarRows.reduce((sum, row) => sum + row.quantity, 0);
            const sortedRows = rows
                .slice()
                .sort((a, b) => (b.isSimilar - a.isSimilar) || (a.delta - b.delta) || (b.quantity - a.quantity))
                .slice(0, 6);

            panel.className = `transfer-intelligence-panel ${location?.is_tray ? "is-tray" : ""}`;
            panel.innerHTML = `
                <div class="transfer-intelligence-head">
                    <div>
                        <span>${escapeTransferHtml(label)}</span>
                        <strong>${escapeTransferHtml(locationLabel.title)}</strong>
                        <small>${escapeTransferHtml(locationLabel.meta || "Storage location")}</small>
                    </div>
                    <div class="transfer-similar-badge">
                        <strong>${similarRows.length.toLocaleString()}</strong>
                        <span>types within 2 g</span>
                    </div>
                </div>
                <div class="transfer-intelligence-stats">
                    <span><small>Item Types</small><strong>${rows.length.toLocaleString()}</strong></span>
                    <span><small>Total Units</small><strong>${totalUnits.toLocaleString()}</strong></span>
                    <span><small>Est. Weight</small><strong>${formatTransferWeight(totalWeight)}</strong></span>
                    <span><small>Similar Units</small><strong>${similarUnits.toLocaleString()}</strong></span>
                </div>
                <div class="transfer-similar-summary">
                    Current item weight: <strong>${formatTransferWeight(getCurrentItemWeight())}</strong>.
                    ${similarRows.length
                        ? `${similarRows.length.toLocaleString()} item type${similarRows.length === 1 ? "" : "s"} and ${similarUnits.toLocaleString()} total unit${similarUnits === 1 ? "" : "s"} match within 2 g.`
                        : "No other item types in this location match within 2 g."}
                </div>
                <div class="transfer-location-items">
                    ${sortedRows.length
                        ? sortedRows.map((row) => `
                            <div class="transfer-location-item ${row.isSimilar ? "is-similar" : ""}">
                                <div>
                                    <strong>${escapeTransferHtml(row.title)}</strong>
                                    <small>${escapeTransferHtml(row.barcode || "No barcode")} · ${formatTransferWeight(row.weight)}</small>
                                </div>
                                <span>${row.quantity.toLocaleString()} unit${row.quantity === 1 ? "" : "s"}</span>
                                ${row.isSimilar ? `<b>${formatTransferWeight(row.delta)} off</b>` : ""}
                            </div>
                        `).join("")
                        : `<div class="transfer-intelligence-empty">No items are currently in this location.</div>`}
                </div>
            `;
        } catch (error) {
            console.error("Failed to load transfer location intelligence:", error);
            setTransferIntelligenceEmpty(error?.message || "Could not load location intelligence.");
        }
    }

    async function fetchTransferStores() {
        const { data, error } = await supabase
            .from("store_locations")
            .select("id, name");

        if (error) {
            console.warn("Could not load store labels for transfer:", error.message);
            return {};
        }

        return Object.fromEntries((data || []).map(store => [store.id, store.name]));
    }

    async function openTransferModal(itemId) {
    try {
        ensureTransferModalLayout();
        const modal = document.getElementById("transfer-modal");
        currentItem = allItems.find(i => i.id === itemId);
        console.log("🔍 currentItem object:", currentItem);
        if (!currentItem) throw new Error("Item not found.");
        document.querySelector("#transfer-modal .modal-header").textContent = "Transfer Stock";
        document.querySelector("#transfer-modal .modal-subtext").textContent = "Move inventory between locations and review the receiving tray before confirming.";
        document.getElementById("confirm-transfer-btn").textContent = "Confirm Transfer";
        document.getElementById("cancel-transfer-btn").textContent = "Cancel";
        setTransferIntelligenceEmpty();

        document.getElementById("transfer-item-title").textContent = currentItem.title || "Untitled";
        if (!Array.isArray(currentItem.photoPaths)) {
            currentItem.photoPaths = Array.isArray(currentItem.photos) ? currentItem.photos : [];
        }

        const itemImageEl = document.getElementById("transfer-item-image");
        console.log("🖼️ Attempting to resolve photo:", currentItem.photoPaths[0]);
        if (currentItem.photoPaths && currentItem.photoPaths.length > 0) {
            const photoPath = currentItem.photoPaths[0]; // just like your checkout uses
            const signedUrl = await checkoutModule.resolveImageUrl(photoPath); // ✅ call the same helper

            itemImageEl.src = signedUrl || "https://via.placeholder.com/100x100?text=No+Image";
        } else {
            itemImageEl.src = "https://via.placeholder.com/100x100?text=No+Image";
        }


        await loadStockBreakdown(itemId);

        modal.classList.remove("hidden");
        document.body.classList.add("modal-open");
    } catch (err) {
        console.error("❌ Failed to open transfer modal:", err);
        showToast("❌ Could not open transfer modal.", "error");
    }
    }

    // 📊 Load current stock breakdown into the modal
    async function loadStockBreakdown(itemId) {
    const breakdownList = document.getElementById("transfer-stock-breakdown");
    const sourceSelect = document.getElementById("transfer-source-location");
    const destSelect = document.getElementById("transfer-destination-location");
    breakdownList.innerHTML = "";
    sourceSelect.innerHTML = `<option value="">-- Choose Source --</option>`;
    destSelect.innerHTML = `<option value="">-- Choose Destination --</option>`;
    const storeMap = await fetchTransferStores();

    // Load existing stock breakdown
    const { data: stockData, error: stockError } = await supabase
        .from("item_stock_locations")
        .select(`
        id, quantity, locked_by, locked_at, condition_status,
        location:location_id (*)
        `)
        .eq("item_id", itemId)
        .eq("condition_status", "good");

    if (stockError || !stockData) {
        console.error("❌ Could not fetch stock locations:", stockError);
        breakdownList.innerHTML = `<li class="error-message">⚠️ Error loading stock data.</li>`;
        return;
    }

    stockData.forEach(loc => {
        const locked = loc.locked_by !== null;
        const locationLabel = formatTransferLocation(loc.location, storeMap);
        const quantity = Number(loc.quantity || 0);
        breakdownList.innerHTML += `
        <li class="${locationLabel.isTray ? "is-tray" : ""}">
            <strong>${escapeTransferHtml(locationLabel.title)}</strong>
            <small>${escapeTransferHtml(locationLabel.meta || "Storage location")}</small>
            <b>${quantity.toLocaleString()} unit${quantity === 1 ? "" : "s"}</b>
            ${locked ? "<em>Locked</em>" : ""}
        </li>
        `;

        if (quantity > 0) {
        sourceSelect.innerHTML += `
            <option value="${loc.id}" data-available-qty="${quantity}">
            ${locationLabel.title}${locationLabel.isTray || locationLabel.isContainer ? ` - ${locationLabel.meta}` : ""} (${quantity})
            </option>
        `;
        }
    });

    // 🚦 Now populate destination locations from the locations table
    const { data: locationsData, error: locationsError } = await supabase
        .from("locations")
        .select("*")
        .eq("active", true);

    if (locationsError || !locationsData) {
        console.error("❌ Could not fetch available locations:", locationsError);
        destSelect.innerHTML = `<option value="">⚠️ Error loading locations</option>`;
        return;
    }

    locationsData.forEach(loc => {
        const locationLabel = formatTransferLocation(loc, storeMap);
        destSelect.innerHTML += `
        <option value="${loc.id}">
            ${locationLabel.title}${locationLabel.isTray || locationLabel.isContainer ? ` - ${locationLabel.meta}` : ""}
        </option>
        `;
    });
    }

    // 🚦 Listen for source selection change to update max quantity display
    function setupListeners() {
        ensureTransferModalLayout();
        const sourceSelect = document.getElementById("transfer-source-location");
        const destSelect = document.getElementById("transfer-destination-location");

        sourceSelect?.addEventListener("change", async (e) => {
            const selected = e.target.options[e.target.selectedIndex];
            maxTransferQty = parseInt(selected?.dataset.availableQty || "0");
            document.getElementById("transfer-max-qty").textContent = maxTransferQty;
            const qtyInput = document.getElementById("transfer-quantity");
            qtyInput.max = maxTransferQty;
            qtyInput.value = ""; // reset quantity input

            const sourceId = sourceSelect.value;

            if (!sourceId) {
                destSelect.innerHTML = `<option value="">-- Choose Destination --</option>`;
                setTransferIntelligenceEmpty();
                return;
            }

            // 🔒 Attempt to lock source location immediately when selected
            if (currentLockedSourceId && currentLockedSourceId !== sourceId) {
                await unlockLocationForTransfer(currentLockedSourceId);
                currentLockedSourceId = null;
            }
            const locked = await lockLocationForTransfer(sourceId);
            if (!locked) {
                showToast("❌ Could not lock source. Please select another or try again.", "error");
                destSelect.innerHTML = `<option value="">-- Choose Destination --</option>`;
                return;
            }

            // 🔍 Fetch the selected source's location_id
            const { data: sourceRecord, error: sourceFetchError } = await supabase
                .from("item_stock_locations")
                .select("location_id")
                .eq("id", sourceId)
                .single();

            if (sourceFetchError || !sourceRecord) {
                console.error("❌ Could not get source location_id:", sourceFetchError?.message);
                return;
            }

            // 🚦 Rebuild destination dropdown excluding the selected source's location
            await renderTransferLocationIntelligence(sourceRecord.location_id, "Source Location");
            destSelect.innerHTML = `<option value="">-- Choose Destination --</option>`;

            const storeMap = await fetchTransferStores();
            const { data: locationsData, error: locationsError } = await supabase
                .from("locations")
                .select("*")
                .eq("active", true);

            if (locationsError || !locationsData) {
                console.error("❌ Could not fetch available locations:", locationsError);
                destSelect.innerHTML = `<option value="">⚠️ Error loading locations</option>`;
                return;
            }

            locationsData.forEach(loc => {
                if (loc.id === sourceRecord.location_id) {
                    // ✅ Skip source location from destination options
                    return;
                }
                const locationLabel = formatTransferLocation(loc, storeMap);
                destSelect.innerHTML += `
                    <option value="${loc.id}">
                    ${locationLabel.title}${locationLabel.isTray || locationLabel.isContainer ? ` - ${locationLabel.meta}` : ""}
                    </option>
                `;
            });
        });


        document.getElementById("confirm-transfer-btn")?.addEventListener("click", handleTransferPasswordConfirmation);

        document.getElementById("cancel-transfer-btn")?.addEventListener("click", closeTransferModal);
        document.getElementById("close-transfer-modal")?.addEventListener("click", closeTransferModal);

        document.getElementById("transfer-destination-location")?.addEventListener("change", async (e) => {
            const destId = e.target.value;
            const destStockEl = document.getElementById("transfer-dest-current-stock");
            destStockEl.classList.add("hidden");
            destStockEl.textContent = "";

            if (!destId) {
                setTransferIntelligenceEmpty();
                return;
            }

            try {
                await renderTransferLocationIntelligence(destId, "Destination");
                const { data: existingDest, error: destFetchError } = await supabase
                    .from("item_stock_locations")
                    .select("quantity")
                    .eq("item_id", currentItem.id)
                    .eq("location_id", destId)
                    .eq("condition_status", "good")
                    .maybeSingle();  // ✅ allows 0 rows without throwing

                if (destFetchError) {
                    console.error("❌ Unexpected error checking destination stock:", destFetchError.message);
                    showToast(`❌ Error checking destination stock: ${destFetchError.message}`, "error");
                    return;
                }

                if (existingDest && existingDest.quantity > 0) {
                    destStockEl.textContent = `Destination currently has ${existingDest.quantity} unit${Number(existingDest.quantity) === 1 ? "" : "s"} of this item.`;
                    destStockEl.classList.remove("hidden");
                } else {
                    console.log(`ℹ️ Destination ${destId} has no existing stock record — assuming 0 units.`);
                    destStockEl.textContent = "Destination currently has 0 units of this item.";
                    destStockEl.classList.remove("hidden");
                }
            } catch (err) {
                console.error("❌ Failed to fetch destination stock:", err);
                showToast(`❌ Failed to fetch destination stock.`, "error");
            }
        });


        window.addEventListener("beforeunload", async () => {
            if (currentLockedSourceId) {
                console.log(`🔓 Unlocking location ${currentLockedSourceId} on page unload.`);
                await unlockLocationForTransfer(currentLockedSourceId);
                currentLockedSourceId = null;
            }
        });

    }


    // ✅ Confirm transfer – fully revamped and fixed to prevent same-location transfers
    async function handleConfirmTransfer() {
        const sourceId = document.getElementById("transfer-source-location").value;
        const destId = document.getElementById("transfer-destination-location").value;
        const qty = parseInt(document.getElementById("transfer-quantity").value);
        const errorEl = document.getElementById("transfer-error-message");
        errorEl.textContent = "";

        if (!sourceId || !destId || !qty || qty <= 0) {
            errorEl.textContent = "Please select valid source, destination, and quantity.";
            return;
        }
        if (qty > maxTransferQty) {
            errorEl.textContent = `Quantity exceeds max available (${maxTransferQty}).`;
            return;
        }

        // 🔍 Fetch the location_id of the selected source
        const { data: sourceRecord, error: sourceFetchError } = await supabase
            .from("item_stock_locations")
            .select("location_id")
            .eq("id", sourceId)
            .single();

        if (sourceFetchError || !sourceRecord) {
            errorEl.textContent = "Could not validate source location.";
            return;
        }

        // ✅ Prevent transfer to the same location
        if (sourceRecord.location_id === destId) {
            errorEl.textContent = "Source and destination cannot be the same location.";
            return;
        }

        try {
            showToast("🔄 Processing transfer...", "info");

            const { data: currentUser, error: userError } = await supabase.auth.getUser();
            if (userError || !currentUser?.user) throw new Error("Could not authenticate user.");

            // 🚦 Lock the source location
            const locked = await lockLocationForTransfer(sourceId);
            if (!locked) throw new Error("Could not lock source location.");

        // 🚦 Check destination record before altering quantities
            const { data: existingDest, error: destFetchError } = await supabase
            .from("item_stock_locations")
            .select("id, quantity")
            .eq("item_id", currentItem.id)
            .eq("location_id", destId)
            .eq("condition_status", "good")
            .maybeSingle(); // ✅ allows 0 rows without throwing

            if (destFetchError) {
            throw new Error(`Error checking destination: ${destFetchError.message}`);
            }

            if (!existingDest) {
            console.log(`ℹ️ No existing stock at destination ${destId} — will insert new record.`);
            }

            // ✅ Perform both stock updates *together* inside try, fail if any error
            const { error: subErr } = await supabase.rpc('subtract_quantity', { loc_id: sourceId, delta: qty });
            if (subErr) throw new Error(`Failed to subtract from source: ${subErr.message}`);

            if (existingDest) {
            const { error: updateError } = await supabase
                .from("item_stock_locations")
                .update({
                quantity: existingDest.quantity + qty,
                last_updated: new Date().toISOString(),
                added_by: currentUser.user.id,
                confirmation_email: currentUser.user.email,
                confirmed_at: new Date().toISOString(),
                confirmation_method: "transfer",
                condition_status: "good"
                })
                .eq("id", existingDest.id);
            if (updateError) throw new Error(`Failed to update destination quantity: ${updateError.message}`);
            } else {
            const { error: insertError } = await supabase
                .from("item_stock_locations")
                .insert({
                item_id: currentItem.id,
                location_id: destId,
                quantity: qty,
                added_by: currentUser.user.id,
                confirmation_email: currentUser.user.email,
                confirmed_at: new Date().toISOString(),
                confirmation_method: "transfer",
                condition_status: "good"
                });
            if (insertError) throw new Error(`Failed to insert destination quantity: ${insertError.message}`);
            }

            // 📑 Log the transfer in stock_transactions
            const { error: logError } = await supabase
            .from("stock_transactions")
            .insert({
                item_id: currentItem.id,
                location_id: destId,
                quantity: qty,
                action_type: "transfer",
                confirmed_at: new Date().toISOString(),
                method: "transfer",
                email: currentUser.user.email,
                user_id: currentUser.user.id,
                notes: `Transferred ${qty} from source location ID ${sourceRecord.location_id} to destination ID ${destId}`,
                stock_condition: "good"
            });
            if (logError) throw new Error(`Failed to log transfer: ${logError.message}`);

            // ✅ All successful: unlock, bump cache, close modal
// ✅ All successful: unlock, bump cache, refresh UI
await unlockLocationForTransfer(sourceId);
await bumpInventoryVersion([currentItem.id]);

// 🔄 Fetch updated item data and refresh card
const { data: updatedItemData, error: updatedItemError } = await supabase
  .from("item_types")
  .select("*")
  .eq("id", currentItem.id)
  .single();

if (updatedItemError || !updatedItemData) {
  console.error("❌ Failed to fetch updated item data:", updatedItemError?.message);
  showToast("⚠️ Transfer succeeded but failed to refresh item card.", "error");
} else {
  const idx = allItems.findIndex(it => it.id === currentItem.id);
  if (idx !== -1) {
    allItems[idx] = updatedItemData;
    if (typeof refreshItemById === "function") {
      await refreshItemById(currentItem.id);
    } else {
      await loadAllItemsWithCache();
    }
  }
}

closeTransferModal();
showToast("✅ Transfer complete!", "success");

        } catch (err) {
            console.error("❌ Transfer failed:", err);
            showToast(`❌ Transfer failed: ${err.message}`, "error");
        }
    }

    //things to do when the modal is closed
    async function closeTransferModal() {
        document.getElementById("transfer-modal").classList.add("hidden");
        document.body.classList.remove("modal-open");

        // ✅ Automatically unlock the source if locked
        if (currentLockedSourceId) {
            console.log(`🔓 Automatically unlocking location ${currentLockedSourceId} because modal was closed.`);
            await unlockLocationForTransfer(currentLockedSourceId);
            currentLockedSourceId = null; // reset tracking
        }
    }

    // 🔐 Lock a specific location for transfer, reusing robust checkout logic style
    async function lockLocationForTransfer(locationId) {
        const { data: currentUser, error: userError } = await supabase.auth.getUser();
        if (userError || !currentUser?.user) {
            showToast("❌ Cannot lock: not authenticated.", "error");
            return false;
        }
        const userId = currentUser.user.id;

        console.log(`🔒 Attempting to lock location ${locationId} for transfer...`);

        const { data: locData, error: fetchError } = await supabase
            .from("item_stock_locations")
            .select("locked_by")
            .eq("id", locationId)
            .single();

        if (fetchError || !locData) {
            console.error(`❌ Failed to check lock status for location ${locationId}:`, fetchError?.message);
            showToast("❌ Could not check lock status.", "error");
            return false;
        }

        if (locData.locked_by) {
            if (locData.locked_by === userId) {
                showToast("✅ Location already locked by you.", "success");
                currentLockedSourceId = locationId; // ✅ track
                return true;
            } else {
                showToast("❌ Location is locked by someone else.", "error");
                return false;
            }
        }

        const { error: lockError } = await supabase
            .from("item_stock_locations")
            .update({
                locked_by: userId,
                locked_at: new Date().toISOString()
            })
            .eq("id", locationId);

        if (lockError) {
            console.error(`❌ Failed to lock location ${locationId}:`, lockError.message);
            showToast(`❌ Could not lock location: ${lockError.message}`, "error");
            return false;
        }

        currentLockedSourceId = locationId; // ✅ set current locked source
        showToast(`✅ Location successfully locked for transfer.`, "success");
        return true;
    }

    // 🔓 Unlock a specific location after transfer, reusing checkout module logic
    async function unlockLocationForTransfer(locationId) {
        const { data: currentUser, error: userError } = await supabase.auth.getUser();
        if (userError || !currentUser?.user) {
            console.warn("❌ Cannot unlock location: no authenticated user.");
            return;
        }

        const userId = currentUser.user.id;

        console.log(`🔓 Releasing lock on location ${locationId} for user ${userId}...`);

        const { error: unlockError } = await supabase
            .from("item_stock_locations")
            .update({
                locked_by: null,
                locked_at: null
            })
            .eq("id", locationId)
            .eq("locked_by", userId);

        if (unlockError) {
            console.error(`❌ Failed to unlock location ${locationId}:`, unlockError.message);
        } else {
            console.log(`✅ Successfully unlocked location ${locationId}.`);
            showToast("🔓 Location lock released.", "success");
        }
    }

    //function to handle the confirmation of the password
    async function handleTransferPasswordConfirmation() {
        const modal = document.getElementById("password-confirm-modal");
        const title = modal.querySelector(".modal-title");
        const desc = modal.querySelector(".modal-desc");
        const confirmBtn = document.getElementById("confirm-password-btn");
        const cancelBtn = document.getElementById("cancel-password-btn");
        const passwordInput = document.getElementById("password-input");
        const errorMsg = document.getElementById("password-error");

        if (!modal || !title || !desc || !confirmBtn || !cancelBtn || !passwordInput) {
            console.error("❌ Missing elements for password confirmation modal.");
            return;
        }

        // Update modal content for transfer context
        title.innerHTML = `
            <span class="material-icons-outlined" style="vertical-align: middle; font-size: 1.6rem; color: #0071e3; margin-right: 6px;">
            swap_horiz
            </span>
            Confirm Stock Transfer
        `;
        desc.textContent = "Enter your password to confirm the transfer of stock.";

        passwordInput.value = "";
        errorMsg.textContent = "";

        // Show the modal
        modal.classList.remove("hidden");
        document.body.classList.add("modal-open");

        // Attach confirm logic
        confirmBtn.onclick = async () => {
            const password = passwordInput.value.trim();
            if (!password) {
            errorMsg.textContent = "Password required.";
            return;
            }

            const valid = await checkoutModule.verifyPasswordForCurrentUser(password);
            if (!valid) {
            errorMsg.textContent = "Incorrect password. Please try again.";
            return;
            }

            modal.classList.add("hidden");
            document.body.classList.remove("modal-open");

            // Proceed with the confirmed transfer
            handleConfirmTransfer();
        };

        // Attach cancel logic
        cancelBtn.onclick = () => {
            modal.classList.add("hidden");
            document.body.classList.remove("modal-open");
        };
    }


  ensureTransferModalLayout();

  return {
    openTransferModal,
    setupListeners,
  };
})();
