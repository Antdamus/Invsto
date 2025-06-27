/* ================= module for edit card modal logic ================ */
window.editCardModule = (function () {
  let currentItemId = null; // store which item is being edited

  // 🔹 Show the edit modal prefilled with item data
  function openEditModal(item) {
    currentItemId = item.id;

    // Fill the modal fields with existing data
    document.getElementById("edit-title").value = item.title || "";
    document.getElementById("edit-description").value = item.description || "";
    document.getElementById("edit-category").value = (item.categories || []).join(", ");
    document.getElementById("edit-quantity").value = typeof item.stock === "number" ? item.stock : "";

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
  }

  // 🔹 Save changes: update Supabase & refresh card
  async function saveItemChanges(e) {
    e.preventDefault();
    if (!currentItemId) {
      console.warn("No item selected for editing.");
      return;
    }

    const title = document.getElementById("edit-title").value.trim();
    const description = document.getElementById("edit-description").value.trim();
    const categories = document.getElementById("edit-category").value
      .split(",")
      .map(s => s.trim())
      .filter(s => s !== "");
    const quantity = parseInt(document.getElementById("edit-quantity").value, 10) || 0;

    const { error } = await supabase
      .from("item_types")
      .update({
        title,
        description,
        categories,
        stock: quantity
      })
      .eq("id", currentItemId);

    if (error) {
      console.error("Error updating item:", error);
      alert("Failed to update item. Please try again.");
      return;
    }

    await bumpInventoryVersion();
    await refreshItemById(currentItemId); // Re-render the specific card

    closeEditModal();
  }

  // 🔹 Add all modal & edit button event listeners
  function setupEditCardListeners() {
    // Close modal button
    document.getElementById("closeEditModal")?.addEventListener("click", closeEditModal);

    // Submit form save
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
  }

  return {
    setupEditCardListeners,
  };
})();
