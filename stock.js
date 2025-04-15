let currentPage = 1;
let itemsPerPage = 12;

let allItems = [];

function getURLParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function updateURLFromForm() {
  const form = document.getElementById("filter-form");
  const formData = new FormData(form);
  const parseOrNull = (val) => {
    const trimmed = typeof val === "string" ? val.trim() : val;
    return trimmed === "" || trimmed === null ? null : parseFloat(trimmed);
  };
  const params = new URLSearchParams();

  for (const [key, value] of formData.entries()) {
    if (value) params.set(key, value);
  }

  if (document.getElementById("sort-select").value)
    params.set("sort", document.getElementById("sort-select").value);

  if (document.getElementById("cards-per-page").value)
    params.set("limit", document.getElementById("cards-per-page").value);

  params.set("page", currentPage);

  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", newUrl);
}


async function fetchStockItems() {
  const { data, error } = await supabase.from("item_types").select("*");

  if (error) {
    console.error("Error loading stock items:", error.message);
    return;
  }

  allItems = data;
  populateDropdowns(data);
  setupFilters();
  setupToggle();
  setupClearFilters();
  setupCSVExport();
  setupPDFExport();
  applySortAndRender(data); // renders based on default sort
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

function setupToggle() {
  const toggleBtn = document.getElementById("toggle-filters");
  const filterSection = document.getElementById("filter-section");

  toggleBtn.addEventListener("click", () => {
    filterSection.classList.toggle("show");
    toggleBtn.textContent = filterSection.classList.contains("show") ? "❌ Hide Filters" : "🔍 Show Filters";
  });
}

function getFilteredItems() {
  const form = document.getElementById("filter-form");
  const formData = new FormData(form);
  const parseOrNull = (val) => {
    const trimmed = typeof val === "string" ? val.trim() : val;
    return trimmed === "" || trimmed === null ? null : parseFloat(trimmed);
  };

  const normalizeDate = (val) => {
    const parsed = new Date(val);
    return isNaN(parsed) ? null : parsed.toISOString().split("T")[0];
  };

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
    stockMin: parseOrNull(formData.get("stockMin")),
    stockMax: parseOrNull(formData.get("stockMax")),
    createdFrom: normalizeDate(formData.get("createdFrom")),
    createdTo: normalizeDate(formData.get("createdTo")),
    category: formData.get("category"),
    qr_type: formData.get("qr_type"),
  };

  return allItems.filter(item => {
    return (!filters.title || item.title?.toLowerCase().includes(filters.title)) &&
           (!filters.description || item.description?.toLowerCase().includes(filters.description)) &&
           (!filters.barcode || item.barcode?.toLowerCase().includes(filters.barcode)) &&
           (!filters.distributor || item.distributor_name?.toLowerCase().includes(filters.distributor)) &&
           (!isNaN(filters.weightMin) ? item.weight >= filters.weightMin : true) &&
           (!isNaN(filters.weightMax) ? item.weight <= filters.weightMax : true) &&
           (!isNaN(filters.costMin) ? item.cost >= filters.costMin : true) &&
           (!isNaN(filters.costMax) ? item.cost <= filters.costMax : true) &&
           (!isNaN(filters.priceMin) ? item.sale_price >= filters.priceMin : true) &&
           (!isNaN(filters.priceMax) ? item.sale_price <= filters.priceMax : true) &&
           (filters.stockMin !== null ? Number(item.stock || 0) >= filters.stockMin : true) &&
           (filters.stockMax !== null ? Number(item.stock || 0) <= filters.stockMax : true) &&
           (!filters.createdFrom || item.created_at >= filters.createdFrom) &&
           (!filters.createdTo || item.created_at <= filters.createdTo) &&
           (!filters.category || item.category === filters.category) &&
           (!filters.qr_type || item.qr_type === filters.qr_type);
  });
}

function setupFilters() {
  const form = document.getElementById("filter-form");
  const inputs = form.querySelectorAll("input, select");

  inputs.forEach(input => {
    input.addEventListener("input", () => {
      currentPage = 1;
      const filtered = getFilteredItems();
      applySortAndRender(filtered);
      updateURLFromForm();
    });
  });

  document.getElementById("sort-select").addEventListener("change", () => {
    currentPage = 1;
    const filtered = getFilteredItems();
    applySortAndRender(filtered);
    updateURLFromForm();
  });

  document.getElementById("cards-per-page").addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value);
    currentPage = 1;
    const filtered = getFilteredItems();
    applySortAndRender(filtered);
    updateURLFromForm();
  });
}


function setupClearFilters() {
  const form = document.getElementById("filter-form");
  const clearBtn = document.getElementById("clear-filters");

  clearBtn.addEventListener("click", () => {
    form.reset();
    applySortAndRender(allItems);
    updateURLFromForm();
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
      const salePrice = getField("Sale Price");
      const distName = getField("Distributor").split('\n')[0];
      const distPhone = getField("Distributor").split('\n')[1] || "";
      const stock = getField("In Stock")?.replace("In Stock: ", "").trim();

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

function applySortAndRender(data) {
  const sortValue = document.getElementById("sort-select").value;
  if (!sortValue) return paginateAndRender(data);

  const [field, direction] = sortValue.split("-");
  const isAsc = direction === "asc";

  const sorted = [...data].sort((a, b) => {
    let valA, valB;

    switch (field) {
      case "title":
        valA = (a.title || "").toLowerCase();
        valB = (b.title || "").toLowerCase();
        return isAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);

      case "weight":
        valA = parseFloat(a.weight || 0);
        valB = parseFloat(b.weight || 0);
        break;

      case "cost":
        valA = parseFloat(a.cost || 0);
        valB = parseFloat(b.cost || 0);
        break;

      case "price":
        valA = parseFloat(a.sale_price || 0);
        valB = parseFloat(b.sale_price || 0);
        break;

      case "stock":
        valA = parseFloat(a.stock || 0);
        valB = parseFloat(b.stock || 0);
        break;

      case "date":
        valA = new Date(a.created_at);
        valB = new Date(b.created_at);
        break;

      default:
        return 0;
    }

    return isAsc ? valA - valB : valB - valA;
  });

  paginateAndRender(sorted);
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

function paginateAndRender(data) {
  const totalItems = data.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (currentPage > totalPages) currentPage = 1;

  const start = (currentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const paginatedItems = data.slice(start, end);

  renderStockItems(paginatedItems);
  renderPaginationControls(totalPages);
}

function renderPaginationControls(totalPages) {
  const container = document.getElementById("pagination-buttons");
  container.innerHTML = "";

  if (totalPages <= 1) return;

  const addBtn = (label, page, isActive = false) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    if (isActive) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentPage = page;
      const filtered = getFilteredItems();
      applySortAndRender(filtered);
      updateURLFromForm(); // ✅ sync new page number to URL
    });
    container.appendChild(btn);
  };

  if (currentPage > 1) {
    addBtn("« Prev", currentPage - 1);
  }

  for (let i = 1; i <= totalPages; i++) {
    addBtn(i, i, i === currentPage);
  }

  if (currentPage < totalPages) {
    addBtn("Next »", currentPage + 1);
  }
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


function applyFiltersFromURL() {
  const params = getURLParams();
  const form = document.getElementById("filter-form");

  for (const [key, value] of Object.entries(params)) {
    const input = form.querySelector(`[name="${key}"]`);
    if (input) input.value = value;
  }

  if (params.limit) {
    itemsPerPage = parseInt(params.limit);
    document.getElementById("cards-per-page").value = params.limit;
  }

  if (params.page) currentPage = parseInt(params.page);
  if (params.sort) document.getElementById("sort-select").value = params.sort;
}

document.addEventListener("DOMContentLoaded", async () => {
  await fetchStockItems(); // load data, setup, dropdowns, etc.
  applyFiltersFromURL();   // then apply filters from URL
  const filtered = getFilteredItems(); // now get filtered list
  applySortAndRender(filtered);        // finally render paginated+sorted
});
