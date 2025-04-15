let allItems = [];

async function fetchStockItems() {
  const { data, error } = await supabase.from("item_types").select("*");

  if (error) {
    console.error("Error loading stock items:", error.message);
    return;
  }

  allItems = data;
  populateDropdowns(data);
  renderStockItems(data);
  setupFilters();
  setupToggle();
  setupClearFilters();
  setupCSVExport();
}

function setupToggle() {
  const toggleBtn = document.getElementById("toggle-filters");
  const filterSection = document.getElementById("filter-section");

  toggleBtn.addEventListener("click", () => {
    filterSection.classList.toggle("show");
    toggleBtn.textContent = filterSection.classList.contains("show") ? "❌ Hide Filters" : "🔍 Show Filters";
  });
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

function setupFilters() {
  const form = document.getElementById("filter-form");
  const inputs = form.querySelectorAll("input, select");

  inputs.forEach(input => {
    input.addEventListener("input", () => {
      const formData = new FormData(form);

      const filters = {
        title: formData.get("title")?.toLowerCase(),
        description: formData.get("description")?.toLowerCase(),
        barcode: formData.get("barcode")?.toLowerCase(),
        distributor: formData.get("distributor")?.toLowerCase(),
        weightMin: parseFloat(formData.get("weightMin")),
        weightMax: parseFloat(formData.get("weightMax")),
        costMin: parseFloat(formData.get("costMin")),
        costMax: parseFloat(formData.get("costMax")),
        priceMin: parseFloat(formData.get("priceMin")),
        priceMax: parseFloat(formData.get("priceMax")),
        stockMin: parseFloat(formData.get("stockMin")),
        stockMax: parseFloat(formData.get("stockMax")),
        category: formData.get("category"),
        qr_type: formData.get("qr_type"),
      };

      const filtered = allItems.filter(item => {
        return (!filters.title || item.title?.toLowerCase().includes(filters.title)) &&
               (!filters.description || item.description?.toLowerCase().includes(filters.description)) &&
               (!filters.barcode || item.barcode?.toLowerCase().includes(filters.barcode)) &&
               (!filters.distributor || (item.distributor_name?.toLowerCase().includes(filters.distributor))) &&
               (!isNaN(filters.weightMin) ? item.weight >= filters.weightMin : true) &&
               (!isNaN(filters.weightMax) ? item.weight <= filters.weightMax : true) &&
               (!isNaN(filters.costMin) ? item.cost >= filters.costMin : true) &&
               (!isNaN(filters.costMax) ? item.cost <= filters.costMax : true) &&
               (!isNaN(filters.priceMin) ? item.sale_price >= filters.priceMin : true) &&
               (!isNaN(filters.priceMax) ? item.sale_price <= filters.priceMax : true) &&
               (!isNaN(filters.stockMin) ? item.stock >= filters.stockMin : true) &&
               (!isNaN(filters.stockMax) ? item.stock <= filters.stockMax : true) &&
               (!filters.category || item.category === filters.category) &&
               (!filters.qr_type || item.qr_type === filters.qr_type);
      });

      renderStockItems(filtered);
    });
  });
}

function setupClearFilters() {
  const form = document.getElementById("filter-form");
  const clearBtn = document.getElementById("clear-filters");

  clearBtn.addEventListener("click", () => {
    form.reset();
    renderStockItems(allItems);
  });
}

function setupCSVExport() {
  const exportBtn = document.getElementById("export-csv");
  exportBtn.addEventListener("click", () => {
    const headers = [
      "Title", "Description", "Weight", "Cost", "Sale Price", "Category",
      "Distributor Name", "Distributor Phone", "Notes", "Barcode", "Stock", "Last Updated"
    ];

    const rows = [headers];

    const visibleCards = document.querySelectorAll(".stock-card");

    visibleCards.forEach(card => {
      const content = card.querySelector(".stock-content");
      const getField = (label) => {
        const p = [...content.querySelectorAll("p")].find(el => el.innerText.startsWith(label));
        return p ? p.innerText.replace(`${label}:`, '').trim() : '';
      };

      const title = content.querySelector("h2")?.innerText || "";
      const description = content.querySelector("p:nth-of-type(1)")?.innerText || "";

      const weight = getField("Weight");
      const cost = getField("Cost");
      const salePrice = getField("Sale Price");
      const category = getField("Category");
      const distName = getField("Distributor").split('\n')[0];
      const distPhone = getField("Distributor").split('\n')[1] || "";
      const notes = getField("Notes");
      const barcode = getField("Barcode");
      const stock = getField("In Stock")?.replace("In Stock: ", "").trim();
      const updated = getField("Last Updated");

      rows.push([
        title, description, weight, cost, salePrice, category,
        distName, distPhone, notes, barcode, stock, updated
      ]);
    });

    const csvContent = rows.map(r => r.map(cell => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "filtered_inventory.csv";
    link.click();
    URL.revokeObjectURL(url);
  });
}

function setupPDFExport() {
  const exportBtn = document.getElementById("export-pdf");
  exportBtn.addEventListener("click", () => {
    const headers = [
      "Title", "Description", "Weight", "Sale Price",
      "Distributor Name", "Distributor Phone",  "Stock"
    ];

    const visibleCards = document.querySelectorAll(".stock-card");

    const rows = [];

    visibleCards.forEach(card => {
      const content = card.querySelector(".stock-content");
      const getField = (label) => {
        const p = [...content.querySelectorAll("p")].find(el => el.innerText.startsWith(label));
        return p ? p.innerText.replace(`${label}:`, '').trim() : '';
      };

      const title = content.querySelector("h2")?.innerText || "";
      const description = content.querySelector("p:nth-of-type(1)")?.innerText || "";

      const weight = getField("Weight");
      //const cost = getField("Cost");
      const salePrice = getField("Sale Price");
      //const category = getField("Category");
      const distName = getField("Distributor").split('\n')[0];
      const distPhone = getField("Distributor").split('\n')[1] || "";
      //const notes = getField("Notes");
      //const barcode = getField("Barcode");
      const stock = getField("In Stock")?.replace("In Stock: ", "").trim();
      //const updated = getField("Last Updated");

      rows.push([
        title, description, weight, salePrice,
        distName, distPhone, stock,
      ]);
    });

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.autoTable({
      head: [headers],
      body: rows,
      styles: {
        font: "helvetica",
        fontSize: 9,
        overflow: "linebreak",
        cellPadding: 3,
      },
      headStyles: {
        fillColor: [0, 113, 227],
        textColor: 255,
      },
      margin: { top: 20 },
      theme: "striped"
    });

    doc.save("filtered_inventory.pdf");
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
        <p><strong>QR Type:</strong> ${item.qr_type}</p>
        <p><strong>Barcode:</strong> ${item.barcode || "—"}</p>
        <p class="stock-count ${stockClass}">In Stock: ${stock}</p>
        <p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>
        <p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>
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

setupPDFExport();
fetchStockItems();
