async function fetchStockItems() {
  const { data, error } = await supabase.from("item_types").select("*");

  if (error) {
    console.error("Error loading stock items:", error.message);
    return;
  }

  const grid = document.getElementById("stock-container");
  grid.innerHTML = "";

  data.forEach(item => {
    const card = document.createElement("div");
    card.className = "stock-card";

    const photos = item.photos || [];
    const primaryPhoto = photos.length > 0 ? photos[0] : "";

    const stock = typeof item.stock === "number" ? item.stock : 0;
    const stockClass = stock === 0 ? "stock-zero" : "";

    card.innerHTML = `
      <div class="stock-image-container">
        ${primaryPhoto ? `<img src="${primaryPhoto}" class="stock-photo-preview" onclick="openModal('${primaryPhoto}')" />` : `<div class="no-photo">No Photo</div>`}
      </div>
      <div class="stock-content">
        <h2>${item.title}</h2>
        <p>${item.description}</p>
        <p><strong>Weight:</strong> ${item.weight}</p>
        <p><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>
        <p><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>
        <p><strong>Category:</strong> ${item.category}</p>
        <p><strong>Distributor:</strong> ${item.distributor_name || "—"}<br/>${item.distributor_phone || ""}</p>
        <p><strong>Notes:</strong> ${item.distributor_notes || "—"}</p>
        <p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>
        <p><strong>QR Type:</strong> ${item.qr_type}</p>
        <p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>
        <p class="stock-count ${stockClass}">In Stock: ${stock}</p>
      </div>
    `;

    grid.appendChild(card);
  });
}

function openModal(imageUrl) {
  const modal = document.getElementById("image-modal");
  const modalImg = document.getElementById("modal-image");
  modal.classList.remove("hidden");
  modalImg.src = imageUrl;
}

function closeModal() {
  document.getElementById("image-modal").classList.add("hidden");
}

document.querySelector(".close-modal").addEventListener("click", closeModal);
document.getElementById("image-modal").addEventListener("click", (e) => {
  if (e.target.id === "image-modal") closeModal();
});

fetchStockItems();
