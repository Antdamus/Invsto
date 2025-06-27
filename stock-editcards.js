/* ================= module for edit card modal logic ================ */
window.editCardModule = (function () {
    let currentItemId = null;
    let originalWeight = null;
    let deletedPhotos = new Set();

    // 🔹 Show the edit modal prefilled with item data
    async function openEditModal(item) {
        currentItemId = item.id;
        originalWeight = parseFloat(item.weight) || 0;
        deletedPhotos.clear();

        document.getElementById("edit-title").value = item.title || "";
        document.getElementById("edit-description").value = item.description || "";
        document.getElementById("edit-weight").value = item.weight || "";
        document.getElementById("edit-cost").value = item.cost || "";
        document.getElementById("edit-sale-price").value = item.sale_price || "";
        document.getElementById("edit-price-per-weight").value = item.price_per_weight || "";
        document.getElementById("edit-stock-batch").value = item.stock_batch_size_update || "";
        document.getElementById("edit-photos").value = ""; // clear file input
        document.getElementById("edit-barcode").value = item.barcode || "";
        document.getElementById("edit-qr-type").value = item.qr_type || "";
        document.getElementById("edit-qr").value = item.qr_code || "";


        // 🔹 Inject current photos preview
        const previewContainer = document.getElementById("current-photos-preview");
        previewContainer.innerHTML = ""; // clear old previews

        const photoPaths = item.photos || [];
        for (const path of photoPaths) {
            const signedUrl = await getSignedUrl(path); // 🔸 your helper function
            const div = document.createElement("div");
            div.classList.add("photo-thumb-container");
            div.innerHTML = `
            <img src="${signedUrl}" alt="Photo thumbnail">
            <button type="button" class="delete-photo-btn" data-path="${path}">&times;</button>
            `;
            previewContainer.appendChild(div);
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
    originalWeight = null;
    }

    // 🔹 Save changes: update Supabase, handle DYMO & photos, refresh card
    async function saveItemChanges(e) {
        e.preventDefault();
        if (!currentItemId) {
            console.warn("No item selected for editing.");
            return;
        }

        const title = document.getElementById("edit-title").value.trim();
        const description = document.getElementById("edit-description").value.trim();
        const weight = parseFloat(document.getElementById("edit-weight").value) || 0;
        const cost = parseFloat(document.getElementById("edit-cost").value) || 0;
        const salePrice = parseFloat(document.getElementById("edit-sale-price").value) || 0;
        const pricePerWeight = parseFloat(document.getElementById("edit-price-per-weight").value) || 0;
        const stockBatch = parseInt(document.getElementById("edit-stock-batch").value, 10) || 0;
        const photosInput = document.getElementById("edit-photos");

        const existingItem = allItems.find(i => i.id === currentItemId);
        if (!existingItem) {
            console.error("Existing item not found in allItems.");
            return;
        }

        let newDymoLabelUrl = existingItem.dymo_label_url;

        // 
        // 🔹 Upload new DYMO label if one was generated
        if (window.latestDymoXml && window.latestDymoUrl) {
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
                alert("Failed to update DYMO label. Please try again.");
                return;
            }

            newDymoLabelUrl = window.latestDymoUrl;
            console.log(`✅ DYMO label uploaded: ${newDymoLabelUrl}`);

            // Clear global DYMO cache
            window.latestDymoXml = "";
            window.latestDymoUrl = "";
        }
   

        // 🔹 Remove deleted photos
        let updatedPhotos = existingItem.photos?.filter(p => !deletedPhotos.has(p)) || [];
        for (const path of deletedPhotos) {
            console.log(`🗑️ Deleting removed photo: ${path}`);
            await supabase.storage.from("photos").remove([path]);
        }
        deletedPhotos.clear();

        // 🔹 Handle new photo uploads
        const uploadedPaths = [];
        if (photosInput?.files?.length) {
            for (let i = 0; i < photosInput.files.length; i++) {
            const photoFile = photosInput.files[i];
            const photoPath = `item-photos/${currentItemId}-${Date.now()}-${photoFile.name}`;
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

        const updates = {
            title,
            description,
            weight,
            cost,
            sale_price: salePrice,
            price_per_weight: pricePerWeight,
            stock_batch_size_update: stockBatch,
            dymo_label_url: newDymoLabelUrl,
            photos: newPhotos,
        };

        const { error } = await supabase.from("item_types").update(updates).eq("id", currentItemId);

        if (error) {
            console.error("Error updating item:", error);
            alert("Failed to update item. Please try again.");
            return;
        }

        await bumpInventoryVersion();
        await refreshItemById(currentItemId);
        showToast("✅ Item updated successfully!");

        closeEditModal();
    }

    // 🔹 Setup all modal & edit button event listeners
    function setupEditCardListeners() {
        document.getElementById("closeEditModal")?.addEventListener("click", closeEditModal);
        document.getElementById("edit-item-form")?.addEventListener("submit", saveItemChanges);

        // Delegated listener: clicks on edit buttons
        document.addEventListener("click", (e) => {
            if (e.target.matches(".edit-item-btn")) {
            const itemId = e.target.dataset.id;
            if (!itemId) return;

            const item = allItems.find(i => i.id === itemId);
            if (!item) {
                console.warn(`Item with ID ${itemId} not found in allItems`);
                return;
            }

            openEditModal(item);
            }
        });

        document.addEventListener("click", (e) => {
            if (e.target.matches(".delete-photo-btn")) {
                const pathToDelete = e.target.dataset.path;
                if (!pathToDelete) return;
                e.target.closest(".photo-thumb-container")?.remove(); // remove from preview
                deletedPhotos.add(pathToDelete);                      // mark for deletion
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
