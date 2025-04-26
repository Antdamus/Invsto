let pendingItem = null; // Store the scanned item awaiting confirmation

// Function to show the confirmation modal
function showModalToConfirmItem(item) {
    pendingItem = item; // Save the item temporarily
  
    const modal = document.getElementById("modalToConfirmItem");
    const modalInfo = document.getElementById("modalItemInfo");
  
    // Clear any previous content
    modalInfo.innerHTML = "";
  
    // Build the card preview
    const previewCard = renderInventoryItem({
      item,
      index: 0, // Preview can just use index 0, no matter
      CardContainerClass: "stock-card preview-mode", // Optional special styling if you want
      ImageContainerClass: "stock-image-container",
      Identifier: "id"
    });
  
    modalInfo.appendChild(previewCard);
  
    // Re-activate lucide icons inside the modal
    lucide.createIcons();
  
    // Show the modal
    modal.classList.remove("hidden");
}
  

// Function to hide the confirmation modal
function hideModalToConfirmItem() {
  const modal = document.getElementById("modalToConfirmItem");
  modal.classList.add("hidden"); // Hide the modal
  pendingItem = null; // Clear pending item
}

// Confirm or cancel actions
function setupModalToConfirmItemListeners() {
  const confirmButton = document.getElementById("confirmAddItemBtn");
  const cancelButton = document.getElementById("cancelAddItemBtn");

  confirmButton.addEventListener("click", () => {
    if (pendingItem) {
      handleScannedItem(pendingItem);
      pendingItem = null;
    }
    hideModalToConfirmItem();
  });

  cancelButton.addEventListener("click", () => {
    hideModalToConfirmItem();
  });

  // Optional: Press "Enter" to confirm automatically
  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("modalToConfirmItem");
    if (!modal.classList.contains("hidden")) {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmButton.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelButton.click();
      }
    }
  });
}

async function processBarcode(barcode) {
    if (!barcode) return;
  
    if (currentBatch[barcode]) {
      incrementCardCount(barcode);
    } else {
      const item = await ExtractItemWithBarcodeFromSupabase(barcode, "item_types", "barcode", true);
      if (item) {
        showModalToConfirmItem(item);
      }
    }
}
  
