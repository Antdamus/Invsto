/* ================= Transfer Stock Module ================= */
window.transferModule = (function () {
  let currentItem = null; // 📦 stores item being transferred
  let maxTransferQty = 0; // 🚦 max quantity at selected source

  // 🚪 Open the transfer modal for a specific item ID
  async function openTransferModal(itemId) {
    try {
      const modal = document.getElementById("transfer-modal");
      currentItem = allItems.find(i => i.id === itemId);
      if (!currentItem) throw new Error("Item not found.");

      document.getElementById("transfer-item-title").textContent = currentItem.title || "Untitled";
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

    const { data, error } = await supabase
      .from("item_stock_locations")
      .select(`
        id, quantity, locked_by, locked_at,
        location:location_id (id, location_name)
      `)
      .eq("item_id", itemId);

    if (error || !data) {
      console.error("❌ Could not fetch stock locations:", error);
      breakdownList.innerHTML = `<li class="error-message">⚠️ Error loading stock data.</li>`;
      return;
    }

    data.forEach(loc => {
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

      // Destination should include all active locations
      destSelect.innerHTML += `
        <option value="${loc.location.id}">
          ${loc.location.location_name}
        </option>
      `;
    });
  }

  // 🚦 Listen for source selection change to update max quantity display
  function setupListeners() {
    document.getElementById("transfer-source-location")?.addEventListener("change", (e) => {
      const selected = e.target.options[e.target.selectedIndex];
      maxTransferQty = parseInt(selected?.dataset.availableQty || "0");
      document.getElementById("transfer-max-qty").textContent = maxTransferQty;
      const qtyInput = document.getElementById("transfer-quantity");
      qtyInput.max = maxTransferQty;
      qtyInput.value = ""; // reset quantity input
    });

    document.getElementById("confirm-transfer-btn")?.addEventListener("click", handleConfirmTransfer);
    document.getElementById("cancel-transfer-btn")?.addEventListener("click", closeTransferModal);
    document.getElementById("close-transfer-modal")?.addEventListener("click", closeTransferModal);
  }

  // ✅ Confirm transfer
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
    if (sourceId === destId) {
      errorEl.textContent = "Source and destination cannot be the same.";
      return;
    }

    try {
      showToast("🔄 Processing transfer...", "info");

      // 🚦 Lock the source location
      const locked = await lockLocationForTransfer(sourceId);
      if (!locked) throw new Error("Could not lock source location.");

      // 🚚 Perform transfer (subtract from source, add to destination)
      const { error: subErr } = await supabase.rpc('subtract_quantity', { loc_id: sourceId, delta: qty });
      if (subErr) throw new Error(`Failed to subtract from source: ${subErr.message}`);

      const { error: addErr } = await supabase.rpc('add_quantity', { loc_id: destId, delta: qty });
      if (addErr) throw new Error(`Failed to add to destination: ${addErr.message}`);

      await unlockLocationForTransfer(sourceId);
      await bumpInventoryVersion([currentItem.id]);

      closeTransferModal();
      showToast("✅ Transfer complete!", "success");
    } catch (err) {
      console.error("❌ Transfer failed:", err);
      showToast(`❌ Transfer failed: ${err.message}`, "error");
    }
  }

  function closeTransferModal() {
    document.getElementById("transfer-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
  }

  // 🔐 Lock a specific location for transfer
  async function lockLocationForTransfer(locationId) {
    const { data: currentUser, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.user) {
      showToast("❌ Cannot lock: not authenticated.", "error");
      return false;
    }

    const { data, error: fetchErr } = await supabase
      .from("item_stock_locations")
      .select("locked_by")
      .eq("id", locationId)
      .single();

    if (fetchErr || !data) {
      console.error(`Failed to check lock status:`, fetchErr?.message);
      showToast("❌ Could not check lock status.", "error");
      return false;
    }

    if (data.locked_by && data.locked_by !== currentUser.user.id) {
      showToast("❌ Location already locked by someone else.", "error");
      return false;
    }

    const { error: lockErr } = await supabase
      .from("item_stock_locations")
      .update({
        locked_by: currentUser.user.id,
        locked_at: new Date().toISOString()
      })
      .eq("id", locationId);

    if (lockErr) {
      console.error(`Failed to lock location:`, lockErr.message);
      showToast("❌ Could not lock location.", "error");
      return false;
    }

    showToast("✅ Location locked for transfer.");
    return true;
  }

  // 🔓 Unlock a specific location
  async function unlockLocationForTransfer(locationId) {
    const { data: currentUser, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.user) return;

    await supabase
      .from("item_stock_locations")
      .update({ locked_by: null, locked_at: null })
      .eq("id", locationId)
      .eq("locked_by", currentUser.user.id);

    showToast("🔓 Location lock released.");
  }

  return {
    openTransferModal,
    setupListeners,
  };
})();
