/* ================= module for edit card modal logic ================ */
window.editCardModule = (function () {
    let currentItemId = null;
    let originalWeight = null;
    let deletedPhotos = new Set();
    let currentItemSnapshot = null;
    let activePhotoDeleteRequest = null;
    let pendingEditSignature = null;

    function canViewSensitiveStockFields() {
        return Boolean(window.stockAccess?.canViewSensitive);
    }

    function getEditItemSelectColumns() {
        if (typeof getStockItemSelectColumns === "function") {
            return getStockItemSelectColumns();
        }
        return canViewSensitiveStockFields()
            ? "*"
            : "id, title, description, weight, stone_type, item_length, sale_price, barcode, qr_code, photo_url, created_at, dymo_label_url, photos, qr_type, categories, stock, stock_batch_size_update, ebay_sync_enabled, ebay_category_id, added_by, added_by_email";
    }

    function setEditFieldVisible(fieldId, visible) {
        const field = document.getElementById(fieldId);
        const label = document.querySelector(`label[for="${fieldId}"]`);
        [label, field].forEach((node) => {
            if (!node) return;
            node.classList.toggle("worker-hidden-edit-field", !visible);
            node.setAttribute("aria-hidden", visible ? "false" : "true");
        });
    }

    function applyEditModalAccessMode() {
        const canSensitive = canViewSensitiveStockFields();
        const modalTitle = document.querySelector("#editItemModal h2");
        if (modalTitle) modalTitle.textContent = canSensitive ? "Edit Inventory Item" : "Correct Item Details";
        const modeNote = document.getElementById("stock-edit-mode-note");
        if (modeNote) {
            modeNote.textContent = canSensitive
                ? "Update item details, pricing, labels, and photos with a signed audit trail."
                : "Workers can correct title, description, weight, stone type, length, and photos with a signed audit trail.";
        }

        [
            "edit-qr-type",
            "edit-qr",
            "edit-cost",
            "edit-sale-price",
            "edit-price-per-weight",
            "edit-stock-batch",
        ].forEach((fieldId) => setEditFieldVisible(fieldId, canSensitive));

        const dymoButton = document.getElementById("generate-edit-dymo-label");
        if (dymoButton) dymoButton.classList.toggle("worker-hidden-edit-field", !canSensitive);

        const saveButton = document.querySelector("#edit-item-form .save-edit-btn");
        if (saveButton) {
            saveButton.classList.remove("worker-hidden-edit-field");
            saveButton.textContent = "Save Signed Change";
        }

        const fileWrapper = document.getElementById("edit-photos")?.closest(".file-input-wrapper");
        if (fileWrapper) fileWrapper.classList.toggle("worker-hidden-edit-field", !canSensitive);
    }

    function escapeEditHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function normalizeEditOption(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function extractStoneFromDescription(description) {
        const text = String(description || "");
        const explicit = text.match(/^\s*(?:stone|stones|gemstone|gemstones)\s*:\s*(.+)$/im)?.[1];
        if (explicit) return normalizeEditOption(explicit);
        const known = [
            ["VVS Simulated Diamonds", /vvs\s+simulated\s+diamonds?/i],
            ["Simulated Diamonds", /simulated\s+diamonds?/i],
            ["Moissanite", /moissanite/i],
            ["CZ", /\b(?:cz|cubic\s+zirconia)\b/i],
            ["Rhinestone", /rhinestone/i],
            ["No Stone", /\bno\s+stones?\b/i],
        ];
        return normalizeEditOption(known.find(([, pattern]) => pattern.test(text))?.[0] || "");
    }

    function extractLengthFromDescription(description) {
        const text = String(description || "");
        const explicit = text.match(/^\s*(?:length|chain length|necklace length|bracelet length)\s*:\s*(.+)$/im)?.[1];
        if (explicit) return normalizeEditOption(explicit);
        return normalizeEditOption(text.match(/\b\d+(?:\.\d+)?\s*(?:inch|inches|in\.|in|cm|mm|")\b/i)?.[0] || "");
    }

    async function loadEditDetailOptions() {
        const stoneList = document.getElementById("edit-stone-type-options");
        const lengthList = document.getElementById("edit-length-options");
        if (!stoneList && !lengthList) return;

        try {
            const { data, error } = await supabase
                .from("item_types")
                .select("stone_type,item_length,description")
                .limit(1000);
            if (error) throw error;

            const stones = new Set();
            const lengths = new Set();
            (data || []).forEach((row) => {
                const stone = normalizeEditOption(row.stone_type || extractStoneFromDescription(row.description));
                const length = normalizeEditOption(row.item_length || extractLengthFromDescription(row.description));
                if (stone) stones.add(stone);
                if (length) lengths.add(length);
            });

            if (stoneList) {
                stoneList.innerHTML = [...stones].sort((a, b) => a.localeCompare(b))
                    .map((value) => `<option value="${escapeEditHtml(value)}"></option>`)
                    .join("");
            }
            if (lengthList) {
                lengthList.innerHTML = [...lengths].sort((a, b) => {
                    const an = Number(String(a).match(/\d+(?:\.\d+)?/)?.[0] || 0);
                    const bn = Number(String(b).match(/\d+(?:\.\d+)?/)?.[0] || 0);
                    return an - bn || a.localeCompare(b);
                }).map((value) => `<option value="${escapeEditHtml(value)}"></option>`)
                    .join("");
            }
        } catch (error) {
            console.warn("Could not load edit detail options:", error);
        }
    }

    //functions needes
    if (typeof getSignedUrl !== "function") {
        async function getSignedUrl(path) {
            if (!path || typeof path !== "string") {
            console.warn("❌ Invalid photo path:", path);
            return null;
            }
            const { data, error } = await supabase
            .storage
            .from("photos")
            .createSignedUrl(path, 3600);
            if (error || !data?.signedUrl) {
            console.warn("⚠️ Failed to sign URL:", path, error?.message || "Unknown error");
            return null;
            }
            return data.signedUrl;
        }

        async function bumpInventoryVersion() {
            const { error } = await supabase
                .from("metadata")
                .update({ inventory_version: crypto.randomUUID() })
                .eq("id", "inventory");

            if (error) {
                console.warn("⚠️ Failed to update inventory version:", error.message);
            } else {
                console.log("🔁 Inventory version updated");
            }
            //await loadAllItemsWithCache();
        }

        async function refreshItemById(itemId) {
        console.log(`🔄 Refreshing item by ID: ${itemId}`);

        // Step 1: Fetch the updated item
        const { data: items, error: itemError } = await supabase
            .from("item_types")
            .select(getEditItemSelectColumns())
            .eq("id", itemId);

        if (itemError || !items || items.length === 0) {
            console.error("❌ Failed to fetch item:", itemError);
            return;
        }

        const item = items[0];

        // Step 2: Sign photo URLs
        if (Array.isArray(item.photos)) {
            const allArePaths = item.photos.every(p => typeof p === "string" && !p.includes("https://"));
            if (allArePaths) {
            item.photoPaths = item.photos; // ✅ Save raw paths only if they’re real paths
            item.photos = [];              // ✅ Clear it for lazy signing
            } else {
            console.warn("⚠️ Skipped converting signed URLs to paths:", item.photos);
            item.photoPaths = []; // Or leave undefined to skip carousel signing
            }
        }

        // Step 3: Get stock info
        const { data: stockData, error: stockError } = await supabase
            .from("item_stock_locations")
            .select("item_id, quantity, location_id")
            .eq("item_id", itemId);

        if (!stockError && stockData) {
            const { data: locations, error: locError } = await supabase
            .from("locations")
            .select("id, location_name");

            if (!locError && locations) {
            const locationMap = Object.fromEntries(locations.map(loc => [loc.id, loc.location_name]));
            const breakdown = {};
            let total = 0;

            stockData.forEach(({ quantity, location_id }) => {
                const locName = locationMap[location_id] || "Unknown Location";
                total += quantity;
                breakdown[locName] = (breakdown[locName] || 0) + quantity;
            });

            item.stock = total;
            item.stock_tooltip = Object.entries(breakdown)
                .map(([loc, qty]) => `${loc}: ${qty}`)
                .join("\n");
            }
        }

        // Step 4: Update it in allItems
        const index = allItems.findIndex(i => i.id === itemId);
        if (index !== -1) {
            allItems[index] = item;
        } else {
            allItems.push(item); // if it's new
        }

        // Step 5: Replace the item card
        const oldCard = document.querySelector(`.stock-card[data-item-id="${itemId}"]`);
        if (oldCard) {
            const newCard = await renderStockCard(item, allItems.findIndex(i => i.id === itemId));
            if (newCard) oldCard.replaceWith(newCard);
            window.lucide.createIcons();
        }
        
        //step 6, update the cache
        const version = await getCurrentInventoryVersionFromSupabase();
        if (version) {
            const cacheKey = typeof getStockCacheKey === "function" ? getStockCacheKey() : "cachedAllItemsWorker";
            sessionStorage.setItem(cacheKey, JSON.stringify({
            version,
            data: allItems
            }));
        }

        console.log("✅ Item refreshed in place:", item.title);
        }
        
        function showToast(message) {
        const container = document.getElementById("toast-container"); // Target container
        //-> you are accessing the div id= toast container node in the DOM (document object model)
        const toast = document.createElement("div"); //this is creating a new div element
        //-> in memory, not in the DOM per se, just a standalone javascript object for now
        //remember the div is just a box
        //and in here toast is not an html id, rather is just a varible holding the pointer to the
        //the object
        toast.className = "toast"; //it just gave the div you created called toast a class name
        toast.textContent = message; //injects the message into the container
        //<div class="toast">Item added!</div>
        container.appendChild(toast); //this is injecting the full javascript object into the 
        //node of the the DOM so now the user can see it live 
        // <div id="toast-container">
        //   <div class="toast">📦 Your toast message</div>
        // </div>

        // Remove toast after 4 seconds
        setTimeout(() => {
            toast.remove();
        }, 4000);
        }
    }

    // 🔹 Show the edit modal prefilled with item data
    async function openEditModal(itemId) {
        console.log(`🔍 Fetching fresh item data for modal: ${itemId}`);
        const { data: items, error } = await supabase
            .from("item_types")
            .select(getEditItemSelectColumns())
            .eq("id", itemId)
            .limit(1);

        if (error || !items || items.length === 0) {
            console.error("❌ Failed to fetch item data for modal:", error);
            alert("Failed to load item data. Please try again.");
            return;
        }

        const item = items[0];
        currentItemId = item.id;
        currentItemSnapshot = item;
        originalWeight = parseFloat(item.weight) || 0;
        deletedPhotos.clear();

        document.getElementById("edit-title").value = item.title || "";
        document.getElementById("edit-description").value = item.description || "";
        document.getElementById("edit-weight").value = item.weight || "";
        document.getElementById("edit-stone-type").value = item.stone_type || extractStoneFromDescription(item.description) || "";
        document.getElementById("edit-length").value = item.item_length || extractLengthFromDescription(item.description) || "";
        document.getElementById("edit-cost").value = item.cost || "";
        document.getElementById("edit-sale-price").value = item.sale_price || "";
        document.getElementById("edit-price-per-weight").value = item.price_per_weight || "";
        document.getElementById("edit-stock-batch").value = item.stock_batch_size_update || "";
        document.getElementById("edit-photos").value = ""; // clear file input
        document.getElementById("edit-change-password").value = "";
        document.getElementById("edit-change-reason").value = "";
        const editError = document.getElementById("edit-change-error");
        if (editError) {
            editError.textContent = "";
            editError.classList.remove("show");
        }
        document.getElementById("edit-barcode").value = item.barcode || "";
        document.getElementById("edit-qr-type").value = item.qr_type || "";
        document.getElementById("edit-qr").value = item.qr_code || "";

        applyEditModalAccessMode();
        loadEditDetailOptions();

        // 🔹 Inject current photos preview
        const previewContainer = document.getElementById("current-photos-preview");
        previewContainer.innerHTML = "";

        const photoPaths = item.photos || [];
        console.log("🖼️ Fetched photoPaths:", photoPaths);

        for (const path of photoPaths) {
            const signedUrl = await getSignedUrl(path);
            console.log("🔗 Signed URL:", signedUrl);
            if (signedUrl) {
                const div = document.createElement("div");
                div.classList.add("photo-thumb-container");
                div.innerHTML = `
                    <img src="${signedUrl}" alt="Photo thumbnail">
                    <button type="button" class="delete-photo-btn" data-path="${path}">&times;</button>
                `;
                previewContainer.appendChild(div);
            }
        }

        const modal = document.getElementById("editItemModal");
        if (modal) {
            modal.classList.remove("hidden");
            document.body.classList.add("modal-open");
        }
    }


    // 🔹 Close the modal and clear state
    function closeEditModal() {
    const modal = document.getElementById("editItemModal");
    if (modal) {
        modal.classList.add("hidden");
        document.body.classList.remove("modal-open");
    }
    currentItemId = null;
    currentItemSnapshot = null;
    originalWeight = null;
        closeEditSignatureConfirmModal();
    }

    // 🔹 Save changes: update Supabase, handle DYMO & photos, refresh card
    function getAuthenticatedStockUser() {
        try {
            if (typeof currentUser !== "undefined" && currentUser) return currentUser;
        } catch (_) {}
        return null;
    }

    async function verifyPhotoDeletePassword(password) {
        const user = getAuthenticatedStockUser();
        if (!user?.email || !password) return false;

        const { error } = await supabase.auth.signInWithPassword({
            email: user.email,
            password,
        });

        return !error;
    }

    async function getOptionalPhotoDeleteLocation() {
        try {
            if (typeof getUserLocation === "function") {
                return await getUserLocation();
            }
        } catch (error) {
            console.warn("Photo deletion location unavailable:", error);
        }
        return null;
    }

    function buildPhotoQuarantinePath(itemId, auditId, originalPath) {
        const fileName = String(originalPath || "photo")
            .split("/")
            .pop()
            .replace(/[^a-z0-9._-]/gi, "_")
            .slice(0, 120) || "photo";
        return `deleted-item-photos/${itemId}/${auditId}/${Date.now()}-${fileName}`;
    }

    async function quarantinePhotoBeforeRemoval(item, photoPath, auditId) {
        const signedUrl = await getSignedUrl(photoPath);
        if (!signedUrl) {
            throw new Error("Could not create a signed URL for the original photo.");
        }

        const response = await fetch(signedUrl);
        if (!response.ok) {
            throw new Error(`Could not download the original photo for quarantine (${response.status}).`);
        }

        const blob = await response.blob();
        const quarantinePath = buildPhotoQuarantinePath(item.id, auditId, photoPath);
        const { error } = await supabase.storage
            .from("photo-quarantine")
            .upload(quarantinePath, blob, {
                upsert: false,
                contentType: blob.type || "application/octet-stream",
            });

        if (error) {
            throw new Error(error.message || "Could not quarantine the photo before deletion.");
        }

        return {
            bucket: "photo-quarantine",
            path: quarantinePath,
        };
    }

    function closePhotoDeleteConfirmModal() {
        document.getElementById("photo-delete-confirm-modal")?.classList.add("hidden");
        document.getElementById("photo-delete-confirm-modal")?.classList.remove("show");
        const passwordInput = document.getElementById("photo-delete-password");
        const reasonInput = document.getElementById("photo-delete-reason");
        const errorMsg = document.getElementById("photo-delete-error");
        if (passwordInput) passwordInput.value = "";
        if (reasonInput) reasonInput.value = "";
        if (errorMsg) {
            errorMsg.textContent = "";
            errorMsg.classList.remove("show");
        }
        activePhotoDeleteRequest = null;
    }

    function setEditSignatureError(message) {
        const editError = document.getElementById("edit-change-error");
        if (!editError) {
            if (message) alert(message);
            return;
        }
        editError.textContent = message || "";
        editError.classList.toggle("show", Boolean(message));
    }

    function openEditSignatureConfirmModal() {
        const modal = document.getElementById("edit-signature-confirm-modal");
        const passwordInput = document.getElementById("edit-change-password");
        const reasonInput = document.getElementById("edit-change-reason");
        if (!modal) return;

        if (passwordInput) passwordInput.value = "";
        if (reasonInput) reasonInput.value = "";
        setEditSignatureError("");
        modal.classList.remove("hidden");
        modal.classList.add("show");
        passwordInput?.focus();
    }

    function closeEditSignatureConfirmModal() {
        const modal = document.getElementById("edit-signature-confirm-modal");
        modal?.classList.add("hidden");
        modal?.classList.remove("show");
        pendingEditSignature = null;
        setEditSignatureError("");
    }

    function confirmEditSignatureAndSubmit() {
        const password = document.getElementById("edit-change-password")?.value?.trim() || "";
        const reason = document.getElementById("edit-change-reason")?.value?.trim() || "";
        if (!password) return setEditSignatureError("Enter your password to sign this edit.");
        if (reason.length < 3) return setEditSignatureError("Add a brief reason for the change.");

        pendingEditSignature = { password, reason };
        document.getElementById("edit-item-form")?.requestSubmit();
    }

    function openPhotoDeleteConfirmModal(path, thumbElement) {
        const item = currentItemSnapshot;
        const modal = document.getElementById("photo-delete-confirm-modal");
        const summary = document.getElementById("photo-delete-confirm-summary");
        const passwordInput = document.getElementById("photo-delete-password");
        const errorMsg = document.getElementById("photo-delete-error");
        const reasonInput = document.getElementById("photo-delete-reason");
        if (!modal || !item || !path) return;

        activePhotoDeleteRequest = { itemId: item.id, photoPath: path, thumbElement };
        if (summary) {
            summary.textContent = `Remove this photo from ${item.title || "this item"}? This action requires your password and will be logged.`;
        }
        if (errorMsg) {
            errorMsg.textContent = "";
            errorMsg.classList.remove("show");
        }
        if (passwordInput) passwordInput.value = "";
        if (reasonInput) reasonInput.value = "";
        modal.classList.remove("hidden");
        modal.classList.add("show");
        passwordInput?.focus();
    }

    async function removePhotoWithAudit() {
        const request = activePhotoDeleteRequest;
        const passwordInput = document.getElementById("photo-delete-password");
        const reasonInput = document.getElementById("photo-delete-reason");
        const errorMsg = document.getElementById("photo-delete-error");
        const confirmBtn = document.getElementById("confirm-photo-delete");
        if (!request?.itemId || !request?.photoPath) return;

        const password = passwordInput?.value?.trim() || "";
        if (!password) {
            if (errorMsg) {
                errorMsg.textContent = "Password required.";
                errorMsg.classList.add("show");
            }
            return;
        }

        if (confirmBtn) confirmBtn.disabled = true;
        if (errorMsg) {
            errorMsg.textContent = "Verifying and creating deletion trail...";
            errorMsg.classList.add("show");
        }

        try {
            const valid = await verifyPhotoDeletePassword(password);
            if (!valid) throw new Error("Incorrect password. Please try again.");

            const { data: items, error: fetchError } = await supabase
                .from("item_types")
                .select(getEditItemSelectColumns())
                .eq("id", request.itemId)
                .limit(1);

            if (fetchError || !items?.length) {
                throw new Error(fetchError?.message || "Could not reload the item before removing the photo.");
            }

            const item = items[0];
            const existingPhotos = Array.isArray(item.photos) ? item.photos : [];
            if (!existingPhotos.includes(request.photoPath)) {
                throw new Error("This photo is no longer attached to the item.");
            }

            const remainingPhotos = existingPhotos.filter((path) => path !== request.photoPath);
            const user = getAuthenticatedStockUser();
            const location = await getOptionalPhotoDeleteLocation();
            const auditPayload = {
                item_id: item.id,
                item_title: item.title || null,
                item_barcode: item.barcode || null,
                photo_path: request.photoPath,
                storage_bucket: "photos",
                deleted_by_email: user?.email || null,
                reason: reasonInput?.value?.trim() || null,
                item_snapshot: item,
                remaining_photos: remainingPhotos,
                location_lat: location?.lat ?? null,
                location_lng: location?.lng ?? null,
                user_agent: navigator.userAgent || null,
                status: "requested",
                storage_removed: false,
            };
            if (user?.id) auditPayload.deleted_by = user.id;

            const { data: auditRow, error: auditError } = await supabase
                .from("photo_deletion_log")
                .insert(auditPayload)
                .select("id")
                .single();

            if (auditError || !auditRow?.id) {
                throw new Error(auditError?.message || "Could not create the photo deletion audit trail.");
            }

            const quarantine = await quarantinePhotoBeforeRemoval(item, request.photoPath, auditRow.id);
            await supabase.from("photo_deletion_log").update({
                status: "quarantined",
                quarantine_bucket: quarantine.bucket,
                quarantine_path: quarantine.path,
                quarantined_at: new Date().toISOString(),
            }).eq("id", auditRow.id);

            const updateResult = canViewSensitiveStockFields()
                ? await supabase
                    .from("item_types")
                    .update({ photos: remainingPhotos })
                    .eq("id", item.id)
                : await supabase.rpc("remove_item_photo", {
                    _item_id: item.id,
                    _photo_path: request.photoPath,
                });
            const updateError = updateResult.error;

            if (updateError) {
                await supabase.from("photo_deletion_log").update({
                    status: "failed",
                    storage_error: updateError.message || "Item update failed",
                }).eq("id", auditRow.id);
                throw new Error(updateError.message || "Could not remove the photo from the item.");
            }

            const { error: storageError } = await supabase.storage.from("photos").remove([request.photoPath]);
            await supabase.from("photo_deletion_log").update({
                status: storageError ? "metadata_removed_storage_failed" : "completed",
                storage_removed: !storageError,
                storage_error: storageError?.message || null,
            }).eq("id", auditRow.id);

            if (typeof signedUrlCache !== "undefined") signedUrlCache.delete(request.photoPath);
            request.thumbElement?.remove();
            deletedPhotos.delete(request.photoPath);
            currentItemSnapshot = { ...item, photos: remainingPhotos };
            await bumpInventoryVersion();
            await refreshItemById(item.id);
            showToast(storageError
                ? "Photo hidden and quarantined, but original storage cleanup needs review."
                : "Photo hidden, quarantined, and audit trail saved.");
            closePhotoDeleteConfirmModal();
        } catch (error) {
            console.error("Photo deletion failed:", error);
            if (activePhotoDeleteRequest?.itemId && activePhotoDeleteRequest?.photoPath) {
                try {
                    await supabase.from("photo_deletion_log").update({
                        status: "failed",
                        storage_error: error?.message || "Photo deletion failed",
                    }).eq("item_id", activePhotoDeleteRequest.itemId)
                      .eq("photo_path", activePhotoDeleteRequest.photoPath)
                      .eq("status", "requested");
                } catch (_) {}
            }
            if (errorMsg) {
                errorMsg.textContent = error?.message || "Could not remove the photo.";
                errorMsg.classList.add("show");
            }
        } finally {
            if (confirmBtn) confirmBtn.disabled = false;
        }
    }

    async function saveItemChanges(e) {
        e.preventDefault();
        if (!currentItemId) {
            console.warn("No item selected for editing.");
            return;
        }

        const title = document.getElementById("edit-title").value.trim();
        const description = document.getElementById("edit-description").value.trim();
        const weight = parseFloat(document.getElementById("edit-weight").value) || 0;
        const stoneType = document.getElementById("edit-stone-type")?.value?.trim() || "";
        const itemLength = document.getElementById("edit-length")?.value?.trim() || "";
        const cost = parseFloat(document.getElementById("edit-cost").value) || 0;
        const salePrice = parseFloat(document.getElementById("edit-sale-price").value) || 0;
        const pricePerWeight = parseFloat(document.getElementById("edit-price-per-weight").value) || 0;
        const stockBatch = parseInt(document.getElementById("edit-stock-batch").value, 10) || 0;
        const photosInput = document.getElementById("edit-photos");
        const signature = pendingEditSignature;
        pendingEditSignature = null;
        const password = signature?.password || "";
        const reason = signature?.reason || "";
        const submitBtn = document.querySelector("#edit-item-form .save-edit-btn");
        const confirmSignatureBtn = document.getElementById("confirm-edit-signature");

        setEditSignatureError("");
        if (!title) {
            alert("Title is required.");
            return;
        }

        if (!signature) {
            openEditSignatureConfirmModal();
            return;
        }

        if (!password) return setEditSignatureError("Enter your password to sign this edit.");
        if (reason.length < 3) return setEditSignatureError("Add a brief reason for the change.");

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Verifying signature...";
        }
        if (confirmSignatureBtn) {
            confirmSignatureBtn.disabled = true;
            confirmSignatureBtn.textContent = "Verifying...";
        }

        const validPassword = await verifyPhotoDeletePassword(password);
        if (!validPassword) {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Save Signed Change";
            }
            if (confirmSignatureBtn) {
                confirmSignatureBtn.disabled = false;
                confirmSignatureBtn.textContent = "Sign and Save";
            }
            return setEditSignatureError("Incorrect password. Please try again.");
        }
        if (submitBtn) submitBtn.textContent = "Saving audited change...";

        // 🔄 Fetch latest item directly from database
        const { data: items, error: fetchError } = await supabase
            .from("item_types")
            .select(getEditItemSelectColumns())
            .eq("id", currentItemId)
            .limit(1);

        if (fetchError || !items || items.length === 0) {
            console.error("❌ Failed to fetch item before saving:", fetchError);
            setEditSignatureError("Failed to fetch current item data. Please try again.");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Save Signed Change";
            }
            if (confirmSignatureBtn) {
                confirmSignatureBtn.disabled = false;
                confirmSignatureBtn.textContent = "Sign and Save";
            }
            return;
        }

        const existingItem = items[0];

        let newDymoLabelUrl = existingItem.dymo_label_url;

        // 
        // 🔹 Upload new DYMO label if one was generated
        if (canViewSensitiveStockFields() && window.latestDymoXml && window.latestDymoUrl) {
            console.log("⬆️ Uploading new DYMO label...");

            // Delete old DYMO file if it exists
            if (existingItem.dymo_label_url) {
                const oldPath = existingItem.dymo_label_url;
                await supabase.storage.from("labels").remove([oldPath]);
            }

            const blob = new Blob([window.latestDymoXml], { type: "application/octet-stream" });
            const { error: uploadError } = await supabase
                .storage
                .from("dymo-labels")
                .upload(window.latestDymoUrl, blob, {
                upsert: true,
                contentType: "application/octet-stream",
                });

            if (uploadError) {
                console.error("Error uploading new DYMO label:", uploadError);
                setEditSignatureError("Failed to update DYMO label. Please try again.");
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Save Signed Change";
                }
                if (confirmSignatureBtn) {
                    confirmSignatureBtn.disabled = false;
                    confirmSignatureBtn.textContent = "Sign and Save";
                }
                return;
            }

            newDymoLabelUrl = window.latestDymoUrl;
            console.log(`✅ DYMO label uploaded: ${newDymoLabelUrl}`);

            // Clear global DYMO cache
            window.latestDymoXml = "";
            window.latestDymoUrl = "";
        }
   

        // 🔹 Remove deleted photos
        const updatedPhotos = existingItem.photos || [];
        for (const path of deletedPhotos) {
            console.log(`🗑️ Deleting removed photo: ${path}`);
            console.log(`Keeping removed photo file for recovery: ${path}`);
        }
        deletedPhotos.clear();

        // 🔹 Handle new photo uploads
        const uploadedPaths = [];
        if (canViewSensitiveStockFields() && photosInput?.files?.length) {
            for (let i = 0; i < photosInput.files.length; i++) {
            const photoFile = photosInput.files[i];
            const photoPath = `item_photos/${currentItemId}-${Date.now()}-${photoFile.name}`;
            const { error: photoErr } = await supabase.storage.from("photos").upload(photoPath, photoFile, { upsert: true });
            if (photoErr) {
                console.error(`Error uploading photo ${photoFile.name}:`, photoErr);
                continue;
            }
            uploadedPaths.push(photoPath);
            }
        }

        // 🔹 Combine kept + new photos
        let newPhotos = [...updatedPhotos, ...uploadedPaths];

        // 🔥 Delete replaced photos not kept or manually deleted
        const photosToRemove = (existingItem.photos || []).filter(
        oldPath => !newPhotos.includes(oldPath)
        );
        for (const oldPath of photosToRemove) {
        console.log(`🗑️ Deleting replaced photo: ${oldPath}`);
        console.log(`Keeping removed photo file for recovery: ${oldPath}`);
        }

        const updates = {
            _item_id: currentItemId,
            _title: title,
            _description: description,
            _weight: weight,
            _stone_type: stoneType,
            _item_length: itemLength,
            _qr_type: document.getElementById("edit-qr-type").value.trim() || null,
            _qr_code: document.getElementById("edit-qr").value.trim() || null,
            _cost: cost,
            _sale_price: salePrice,
            _price_per_weight: pricePerWeight,
            _stock_batch_size_update: stockBatch,
            _dymo_label_url: newDymoLabelUrl,
            _photos: canViewSensitiveStockFields() ? newPhotos : null,
            _reason: reason,
            _signed_by_email: getAuthenticatedStockUser()?.email || null,
        };

        const { error } = await supabase.rpc("update_certified_item_details", updates);

        if (error) {
            console.error("Error updating item:", error);
            setEditSignatureError(error.message || "Failed to update item. Please try again.");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Save Signed Change";
            }
            if (confirmSignatureBtn) {
                confirmSignatureBtn.disabled = false;
                confirmSignatureBtn.textContent = "Sign and Save";
            }
            return;
        }

        await bumpInventoryVersion();
        await refreshItemById(currentItemId);
        showToast("Item updated and signed audit trail saved.");

        closeEditSignatureConfirmModal();
        closeEditModal();
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Save Signed Change";
        }
        if (confirmSignatureBtn) {
            confirmSignatureBtn.disabled = false;
            confirmSignatureBtn.textContent = "Sign and Save";
        }
    }

    // 🔹 Setup all modal & edit button event listeners
    function setupEditCardListeners() {
        document.getElementById("closeEditModal")?.addEventListener("click", closeEditModal);
        document.getElementById("cancelEditModal")?.addEventListener("click", closeEditModal);
        document.getElementById("edit-item-form")?.addEventListener("submit", saveItemChanges);
        document.getElementById("close-edit-signature-confirm")?.addEventListener("click", closeEditSignatureConfirmModal);
        document.getElementById("cancel-edit-signature-confirm")?.addEventListener("click", closeEditSignatureConfirmModal);
        document.getElementById("confirm-edit-signature")?.addEventListener("click", confirmEditSignatureAndSubmit);
        document.getElementById("edit-change-password")?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                confirmEditSignatureAndSubmit();
            }
        });

        // Delegated listener: clicks on edit buttons
        document.addEventListener("click", (e) => {
            const editButton = e.target.closest(".edit-item-btn");
            if (editButton) {
                const itemId = editButton.dataset.id;
                if (!itemId) return;
                openEditModal(itemId); // now just pass the ID!
            }
        });

        document.addEventListener("click", (e) => {
            if (e.target.matches(".delete-photo-btn")) {
                const pathToDelete = e.target.dataset.path;
                if (!pathToDelete) return;
                openPhotoDeleteConfirmModal(pathToDelete, e.target.closest(".photo-thumb-container"));
            }
        });

        document.getElementById("close-photo-delete-confirm")?.addEventListener("click", closePhotoDeleteConfirmModal);
        document.getElementById("cancel-photo-delete-confirm")?.addEventListener("click", closePhotoDeleteConfirmModal);
        document.getElementById("confirm-photo-delete")?.addEventListener("click", removePhotoWithAudit);
        document.getElementById("photo-delete-password")?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                removePhotoWithAudit();
            }
        });

        document.getElementById("generate-edit-dymo-label")?.addEventListener("click", async () => {
            try {
                const barcode = document.getElementById("edit-barcode").value.trim();
                const qr = document.getElementById("edit-qr").value.trim();
                const price = parseFloat(document.getElementById("edit-weight").value) || 0;
                const typeqr = document.getElementById("edit-qr-type").value.trim();

                const { templateXml, labelPath } = await dymoModule.generateAndUploadDymoLabel({
                barcode,
                qr,
                price,
                typeqr,
                });

                const blob = new Blob([templateXml], { type: "application/octet-stream" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "OGJewelryLabel.dymo";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                window.latestDymoXml = templateXml;
                window.latestDymoUrl = labelPath;

                showToast(`✅ DYMO label generated. Will upload on save.`);
            } catch (err) {
                console.error("❌ DYMO generation failed:", err);
                alert(`DYMO generation failed: ${err.message || err}`);
            }
        });
    }

  return {
    setupEditCardListeners,
  };
})();
