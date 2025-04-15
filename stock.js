async function fetchStockItems() {
  const { data, error } = await supabase.from("item_types").select("*");

  if (error) {
    console.error("Error loading stock items:", error.message);
    return;
  }

  const grid = document.getElementById("stock-container");
  grid.innerHTML = "";

  data.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "stock-card";

    const photos = item.photos || [];
    const stock = typeof item.stock === "number" ? item.stock : 0;
    const stockClass = stock === 0 ? "stock-zero" : "";

    // Build carousel HTML
    const photoCarousel = photos.length
      ? `
        <div class="carousel" id="carousel-${index}">
          <button class="carousel-btn left" onclick="prevSlide(${index})">&#10094;</button>
          <div class="carousel-track">
            ${photos.map((photo, i) => `<img src="${photo}" class="carousel-photo ${i === 0 ? 'active' : ''}" />`).join('')}
          </div>
          <button class="carousel-btn right" onclick="nextSlide(${index})">&#10095;</button>
        </div>
      `
      : `<div class="no-photo">No Photos</div>`;

    card.innerHTML = `
      <div class="stock-image-container">${photoCarousel}</div>
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

function nextSlide(index) {
  const carousel = document.getElementById(`carousel-${index}`);
  const track = carousel.querySelector(".carousel-track");
  const images = track.querySelectorAll(".carousel-photo");
  const currentIndex = [...images].findIndex(img => img.classList.contains("active"));

  images[currentIndex].classList.remove("active");
  const nextIndex = (currentIndex + 1) % images.length;
  images[nextIndex].classList.add("active");
}

function prevSlide(index) {
  const carousel = document.getElementById(`carousel-${index}`);
  const track = carousel.querySelector(".carousel-track");
  const images = track.querySelectorAll(".carousel-photo");
  const currentIndex = [...images].findIndex(img => img.classList.contains("active"));

  images[currentIndex].classList.remove("active");
  const prevIndex = (currentIndex - 1 + images.length) % images.length;
  images[prevIndex].classList.add("active");
}

fetchStockItems();
