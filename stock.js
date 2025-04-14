// === stock.js ===

const supabase = window.supabase;
const container = document.getElementById("stock-container");
const modal = document.getElementById("image-modal");
const modalImg = document.getElementById("modal-image");
const closeModal = document.querySelector(".close-modal");

function openModal(src) {
  modal.classList.add("show");
  modalImg.src = src;
}

closeModal.addEventListener("click", () => modal.classList.remove("show"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.remove("show");
});

async function loadInventory() {
  const { data, error } = await supabase.from("item_types").select("*");
  console.log("Fetched inventory:", data);
  console.log("Fetch error:", error);
  if (error) {
    console.error("Error loading inventory:", error);
    container.innerHTML = "<p>Failed to load inventory.</p>";
    return;
  }

  container.innerHTML = "";

  data.forEach((item) => {
    const card = document.createElement("div");
    card.className = "stock-card";

    const photos = Array.isArray(item.photos) ? item.photos : [];
    let currentPhotoIndex = 0;

    card.innerHTML = `
      <h2 class="stock-title">${item.title}</h2>
      <div class="stock-field"><strong>Description:</strong> ${item.description}</div>
      <div class="stock-field"><strong>Weight:</strong> ${item.weight} g/ct</div>
      <div class="stock-field"><strong>Cost:</strong> $${item.cost.toLocaleString()}</div>
      <div class="stock-field"><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</div>
      <div class="stock-field"><strong>Category:</strong> ${item.category}</div>
      <div class="stock-field"><strong>Distributor:</strong> ${item.distributor_name || "N/A"}</div>
      <div class="stock-field"><strong>Phone:</strong> ${item.distributor_phone || "N/A"}</div>
      <div class="stock-field"><strong>Notes:</strong> ${item.distributor_notes || "None"}</div>
      <div class="stock-field"><strong>QR Type:</strong> ${item.qr_type || "N/A"}</div>
      <div class="stock-field"><strong>DYMO Label:</strong> <a href="${item.dymo_label_url}" target="_blank">Download</a></div>
      <div class="stock-field"><strong>Last Updated:</strong> ${new Date(item.updated_at || item.created_at).toLocaleString()}</div>
      <div class="stock-photos">
        <button class="photo-nav prev-photo">&#8592;</button>
        <img src="${photos[0] || ''}" class="stock-photo-preview" alt="Photo Preview">
        <button class="photo-nav next-photo">&#8594;</button>
      </div>
    `;

    const photoEl = card.querySelector(".stock-photo-preview");
    const prevBtn = card.querySelector(".prev-photo");
    const nextBtn = card.querySelector(".next-photo");

    // Handle photo carousel
    if (photos.length > 1) {
      prevBtn.onclick = () => {
        currentPhotoIndex = (currentPhotoIndex - 1 + photos.length) % photos.length;
        photoEl.src = photos[currentPhotoIndex];
      };
      nextBtn.onclick = () => {
        currentPhotoIndex = (currentPhotoIndex + 1) % photos.length;
        photoEl.src = photos[currentPhotoIndex];
      };
    } else {
      prevBtn.style.display = "none";
      nextBtn.style.display = "none";
    }

    // Enlarge on click
    photoEl.onclick = () => {
      if (photoEl.src) openModal(photoEl.src);
    };

    container.appendChild(card);
  });
}

loadInventory();
