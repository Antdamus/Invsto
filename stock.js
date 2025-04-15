async function fetchStockItems() {
  const { data, error } = await supabase.from("item_types").select("*");

  if (error) {
    console.error("Error loading stock items:", error.message);
    return;
  }

  populateDropdowns(data);
  renderStockItems(data);
  setupFilters(data);
}

function populateDropdowns(data) {
  const categorySelect = document.querySelector("select[name='category']");
  const qrTypeSelect = document.querySelector("select[name='qr_type']");

  const categories = [...new Set(data.map(item => item.category).filter(Boolean))];
  const qrTypes = [...new Set(data.map(item => item.qr_type).filter(Boolean))];

  for (const c of categories) {
    categorySelect.innerHTML += `<option value="${c}">${c}</option>`;
  }
  for (const q of qrTypes) {
    qrTypeSelect.innerHTML += `<option value="${q}">${q}</option>`;
  }
}

function setupFilters(originalData) {
  const form = document.getElementById("filter-form");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const formData = new FormData(form);

    const filters = {
      title: formData.get("title")?.toLowerCase(),
      description: formData.get("description")?.toLowerCase(),
      weightMin: parseFloat(formData.get("weightMin")),
      weightMax: parseFloat(formData.get("weightMax")),
      costMin: parseFloat(formData.get("costMin")),
      costMax: parseFloat(formData.get("costMax")),
      priceMin: parseFloat(formData.get("priceMin")),
      priceMax: parseFloat(formData.get("priceMax")),
      distributor: formData.get("distributor")?.toLowerCase(),
      category: formData.get("category"),
      qr_type: formData.get("qr_type"),
      stockMin: parseFloat(formData.get("stockMin")),
      stockMax: parseFloat(formData.get("stockMax")),
    };

    const filtered = originalData.filter(item => {
      return (!filters.title || item.title?.toLowerCase().includes(filters.title)) &&
             (!filters.description || item.description?.toLowerCase().includes(filters.description)) &&
             (!isNaN(filters.weightMin) ? item.weight >= filters.weightMin : true) &&
             (!isNaN(filters.weightMax) ? item.weight <= filters.weightMax : true) &&
             (!isNaN(filters.costMin) ? item.cost >= filters.costMin : true) &&
             (!isNaN(filters.costMax) ? item.cost <= filters.costMax : true) &&
             (!isNaN(filters.priceMin) ? item.sale_price >= filters.priceMin : true) &&
             (!isNaN(filters.priceMax) ? item.sale_price <= filters.priceMax : true) &&
             (!filters.distributor || (item.distributor_name?.toLowerCase().includes(filters.distributor))) &&
             (!filters.category || item.category === filters.category) &&
             (!filters.qr_type || item.qr_type === filters.qr_type) &&
             (!isNaN(filters.stockMin) ? item.stock >= filters.stockMin : true) &&
             (!isNaN(filters.stockMax) ? item.stock <= filters.stockMax : true);
    });

    renderStockItems(filtered);
  });
}

function renderStockItems(data) {
  const grid = document.getElementById("stock-container");
  grid.innerHTML = "";

  data.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "stock-card";

    const photos = item.photos || [];
    const stock = typeof item.stock === "number" ? item.stock : 0;
    const stockClass = stock === 0 ? "stock-zero" : "";

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
