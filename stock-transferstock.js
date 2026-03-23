/* ================= Transfer Stock Module ================= */
window.transferModule = (function () {
    let currentItem = null; // 📦 stores item being transferred
    let maxTransferQty = 0; // 🚦 max quantity at selected source
    let currentLockedSourceId = null; // 🛡️ Track locked source location ID


    // 🚪 Open the transfer modal for a specific item ID
    async function openTransferModal(itemId) {
    try {
        const modal = document.getElementById("transfer-modal");
        currentItem = allItems.find(i => i.id === itemId);
        console.log("🔍 currentItem object:", currentItem);
        if (!currentItem) throw new Error("Item not found.");

        document.getElementById("transfer-item-title").textContent = currentItem.title || "Untitled";

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

    // Load existing stock breakdown
    const { data: stockData, error: stockError } = await supabase
        .from("item_stock_locations")
        .select(`
        id, quantity, locked_by, locked_at,
        location:location_id (id, location_name)
        `)
        .eq("item_id", itemId);

    if (stockError || !stockData) {
        console.error("❌ Could not fetch stock locations:", stockError);
        breakdownList.innerHTML = `<li class="error-message">⚠️ Error loading stock data.</li>`;
        return;
    }

    stockData.forEach(loc => {
        const locked = loc.locked_by !== null;
        breakdownList.innerHTML += `
        <li>
            ${loc.location.location_name}: ${loc.quantity} 
            ${locked ? "<span style='color:red;'>🔒 LOCKED</span>" : ""}
        </li>
        `;

        if (loc.quantity > 0) {
        sourceSelect.innerHTML += `
            <option value="${loc.id}" data-available-qty="${loc.quantity}">
            ${loc.location.location_name} (${loc.quantity})
            </option>
        `;
        }
    });

    // 🚦 Now populate destination locations from the locations table
    const { data: locationsData, error: locationsError } = await supabase
        .from("locations")
        .select("id, location_name")
        .eq("active", true);

    if (locationsError || !locationsData) {
        console.error("❌ Could not fetch available locations:", locationsError);
        destSelect.innerHTML = `<option value="">⚠️ Error loading locations</option>`;
        return;
    }

    locationsData.forEach(loc => {
        destSelect.innerHTML += `
        <option value="${loc.id}">
            ${loc.location_name}
        </option>
        `;
    });
    }

    // 🚦 Listen for source selection change to update max quantity display
    function setupListeners() {
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
                return;
            }

            // 🔒 Attempt to lock source location immediately when selected
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
            destSelect.innerHTML = `<option value="">-- Choose Destination --</option>`;

            const { data: locationsData, error: locationsError } = await supabase
                .from("locations")
                .select("id, location_name")
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
                destSelect.innerHTML += `
                    <option value="${loc.id}">
                    ${loc.location_name}
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

            if (!destId) return; // nothing selected

            try {
                const { data: existingDest, error: destFetchError } = await supabase
                    .from("item_stock_locations")
                    .select("quantity")
                    .eq("item_id", currentItem.id)
                    .eq("location_id", destId)
                    .maybeSingle();  // ✅ allows 0 rows without throwing

                if (destFetchError) {
                    console.error("❌ Unexpected error checking destination stock:", destFetchError.message);
                    showToast(`❌ Error checking destination stock: ${destFetchError.message}`, "error");
                    return;
                }

                if (existingDest && existingDest.quantity > 0) {
                    destStockEl.textContent = `📦 Destination currently has ${existingDest.quantity} units.`;
                    destStockEl.classList.remove("hidden");
                } else {
                    console.log(`ℹ️ Destination ${destId} has no existing stock record — assuming 0 units.`);
                    destStockEl.textContent = `ℹ️ Destination currently has 0 units.`;
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
                confirmation_email: currentUser.email,
                confirmed_at: new Date().toISOString(),
                confirmation_method: "transfer"
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
                confirmation_email: currentUser.email,
                confirmed_at: new Date().toISOString(),
                confirmation_method: "transfer"
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
                email: currentUser.email,
                user_id: currentUser.user.id,
                notes: `Transferred ${qty} from source location ID ${sourceRecord.location_id} to destination ID ${destId}`
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
    renderSingleInventoryCard(allItems[idx]); // ✅ refresh the card
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


  return {
    openTransferModal,
    setupListeners,
  };
})();
