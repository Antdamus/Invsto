
// === DOM Elements ===
const grid = document.getElementById("stock-grid");
const toggleFilters = document.getElementById("toggle-filters");
const filters = document.getElementById("filters");

// === Toggle filter visibility ===
toggleFilters?.addEventListener("click", () => {
  filters.classList.toggle("hidden");
});

// === Load Items ===
async function loadInventory() {
  const { data, error } = await supabase.from("item_types").select("*");

  if (error) {
    console.error("Error loading items:", error.message);
    grid.innerHTML = "<p>❌ Failed to load inventory.</p>";
    return;
  }

  if (!data.length) {
    grid.innerHTML = "<p>No inventory items available.</p>";
    return;
  }

  data.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "stock-card";

    // Image carousel
    const carousel = document.createElement("div");
    carousel.className = "stock-carousel";

    const carouselImages = item.photos || [];
    carouselImages.forEach((url, i) => {
      const img = document.createElement("img");
      img.src = url;
      if (i === 0) img.classList.add("active");
      carousel.appendChild(img);
    });

    const carouselButtons = document.createElement("div");
    carouselButtons.className = "carousel-buttons";

    const prevBtn = document.createElement("button");
    prevBtn.innerHTML = "‹";
    const nextBtn = document.createElement("button");
    nextBtn.innerHTML = "›";
    carouselButtons.appendChild(prevBtn);
    carouselButtons.appendChild(nextBtn);
    carousel.appendChild(carouselButtons);

    // Carousel logic
    let current = 0;
    const images = carousel.querySelectorAll("img");

    prevBtn.onclick = () => {
      images[current].classList.remove("active");
      current = (current - 1 + images.length) % images.length;
      images[current].classList.add("active");
    };

    nextBtn.onclick = () => {
      images[current].classList.remove("active");
      current = (current + 1) % images.length;
      images[current].classList.add("active");
    };

    // Title
    const title = document.createElement("h3");
    title.textContent = item.title;

    // Info
    const details = document.createElement("div");
    details.innerHTML = `
      <p class="stock-detail"><strong>Description:</strong> ${item.description}</p>
      <p class="stock-detail"><strong>Weight:</strong> ${item.weight}</p>
      <p class="stock-detail"><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>
      <p class="stock-detail"><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>
      <p class="stock-detail"><strong>Category:</strong> ${item.category}</p>
      <p class="stock-detail"><strong>Distributor:</strong> ${item.distributor_name || "N/A"} (${item.distributor_phone || "N/A"})</p>
      <p class="stock-detail"><strong>Notes:</strong> ${item.distributor_notes || "None"}</p>
      <p class="stock-detail"><strong>QR Type:</strong> ${item.qr_type}</p>
      <p class="stock-detail"><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>
    `;

    // Footer
    const footer = document.createElement("div");
    footer.className = "stock-footer";

    const stockCount = document.createElement("span");
    stockCount.className = "stock-count";
    stockCount.textContent = `Stock: ${item.stock || 0}`;
    if ((item.stock || 0) === 0) stockCount.classList.add("zero");

    const downloadBtn = document.createElement("a");
    downloadBtn.href = item.dymo_label_url || "#";
    downloadBtn.className = "download-button";
    downloadBtn.download = `label_${item.barcode || "item"}.dymo`;
    downloadBtn.textContent = "Download Label";

    footer.appendChild(stockCount);
    footer.appendChild(downloadBtn);

    // Assemble card
    card.appendChild(carousel);
    card.appendChild(title);
    card.appendChild(details);
    card.appendChild(footer);

    grid.appendChild(card);
  });
}

// === Start ===
loadInventory();
