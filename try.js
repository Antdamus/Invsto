 //coorinating the rendering the pop up
 function showModalToConfirmItem(item) {
  pendingItem = item; // Save the item temporarily

  const modal = document.getElementById("modalToConfirmItem");
  const modalInfo = document.querySelector("#modalItemInfo"); // ✅ No change here

  // Clear any previous content
  modalInfo.innerHTML = "";

  // Build the card preview
  const previewCard = renderInventoryItem({
    item,
    index: 0, // Preview just uses index 0
    CardContainerClass: "stock-content", // 💡 IMPORTANT: match the clean class, not "stock-card" anymore!
    ImageContainerClass: "stock-image-container",
    Identifier: "id"
  });

  modalInfo.appendChild(previewCard);

  // Re-activate lucide icons inside the modal
  lucide.createIcons();

  // Show the modal
  modal.classList.remove("hidden");
}
