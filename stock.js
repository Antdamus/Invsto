let currentPage = 1;
let itemsPerPage = 12;
let allItems = [];
let userFavorites = new Set();
let currentUser = null;
let selectedItems = new Set();
let showOnlyFavorites = false;

function showToast(message) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function showLoading() {
  document.getElementById("loading-overlay").classList.add("show");
}

function hideLoading() {
  document.getElementById("loading-overlay").classList.remove("show");
}


function updateFilterChips(filters) {
  const chipContainer = document.getElementById("filter-chips");
  if (!chipContainer) return;
  chipContainer.innerHTML = "";

  const createChip = (label, key) => {
    const chip = document.createElement("div");
    chip.className = "filter-chip";
    chip.innerHTML = `${label} <button data-key="${key}">&times;</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      if (key === "categories") {
        document.querySelectorAll(".dropdown-option.selected").forEach(el => {
          if (el.dataset.cat === label.split(": ")[1]) {
            el.classList.remove("selected");
          }
        });
      } else {
        const input = document.querySelector(`[name="${key}"]`);
        if (input) input.value = "";
      }
      
      currentPage = 1;
      const filtered = getFilteredItems();
      applySortAndRender(filtered);
      updateFilterChips(getActiveFilters());
      updateURLFromForm();
    });
    chipContainer.appendChild(chip);
  };

  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === "") continue;
    let label = "";
    switch (key) {
      case "title": label = `Title: "${value}"`; break;
      case "description": label = `Description: "${value}"`; break;
      case "barcode": label = `Barcode: ${value}`; break;
      case "distributor": label = `Distributor: ${value}`; break;
      case "weightMin": label = `Weight ≥ ${value}`; break;
      case "weightMax": label = `Weight ≤ ${value}`; break;
      case "costMin": label = `Cost ≥ ${value}`; break;
      case "costMax": label = `Cost ≤ ${value}`; break;
      case "priceMin": label = `Price ≥ ${value}`; break;
      case "priceMax": label = `Price ≤ ${value}`; break;
      case "stockMin": label = `Stock ≥ ${value}`; break;
      case "stockMax": label = `Stock ≤ ${value}`; break;
      case "createdFrom": label = `Created ≥ ${value}`; break;
      case "createdTo": label = `Created ≤ ${value}`; break;
      case "category": label = `Category: ${value}`; break;
      case "qr_type": label = `QR: ${value}`; break;
      case "categories":
        value.forEach(cat => {
          createChip(`Category: ${cat}`, "categories");
        });
        continue;
      default: continue;
    }
    createChip(label, key);
  }
}

async function removeCategory(itemId, category) {
  const { data, error } = await supabase
    .from("item_types")
    .select("categories")
    .eq("id", itemId)
    .single();

  if (error || !data) return console.error("Error fetching item:", error);

  const newCategories = (data.categories || []).filter(cat => cat !== category);

  await supabase
    .from("item_types")
    .update({ categories: newCategories })
    .eq("id", itemId);

  await fetchStockItems();
  const filtered = getFilteredItems();
  applySortAndRender(filtered);
  updateFilterChips(getActiveFilters());
}

async function addCategory(itemId) {
  const newCat = prompt("Enter new category:");
  if (!newCat) return;

  const { data, error } = await supabase
    .from("item_types")
    .select("categories")
    .eq("id", itemId)
    .single();

  if (error || !data) return console.error("Error fetching item:", error);

  const newCategories = new Set([...(data.categories || []), newCat]);

  await supabase
    .from("item_types")
    .update({ categories: Array.from(newCategories) })
    .eq("id", itemId);

  await fetchStockItems();
  const filtered = getFilteredItems();
  applySortAndRender(filtered);
  updateFilterChips(getActiveFilters());
}

async function applyCategory(itemId, newCategory) {
  const { data, error } = await supabase
    .from("item_types")
    .select("categories")
    .eq("id", itemId)
    .single();

  if (error || !data) return;

  const newSet = new Set([...(data.categories || []), newCategory]);

  await supabase
    .from("item_types")
    .update({ categories: Array.from(newSet) })
    .eq("id", itemId);

  await fetchStockItems();
  const filtered = getFilteredItems();
  applySortAndRender(filtered);
  updateFilterChips(getActiveFilters());
}


let activeDropdown = null;

async function showCategoryDropdown(itemId, anchorElement) {
  if (activeDropdown) activeDropdown.remove();

  const { data, error } = await supabase.from("item_types").select("categories").eq("id", itemId).single();
  const allItems = await supabase.from("item_types").select("categories");
  const allCategories = Array.from(
    new Set(allItems.data.flatMap(item => item.categories || []))
  );

  const selected = new Set();

  const dropdown = document.createElement("div");
  dropdown.className = "category-dropdown";

  const input = document.createElement("input");
  input.placeholder = "Search or create...";
  dropdown.appendChild(input);

  const optionsContainer = document.createElement("div");
  dropdown.appendChild(optionsContainer);

  const saveBtn = document.createElement("div");
  saveBtn.className = "category-option";
  saveBtn.style.fontWeight = "bold";
  saveBtn.style.textAlign = "center";
  saveBtn.style.borderTop = "1px solid #eee";
  saveBtn.style.marginTop = "6px";
  saveBtn.style.cursor = "pointer";
  saveBtn.textContent = "✅ Add Selected";
  dropdown.appendChild(saveBtn);

  function renderOptions(filter = "") {
    optionsContainer.innerHTML = "";
    const filtered = allCategories.filter(cat => cat.toLowerCase().includes(filter.toLowerCase()));

    filtered.forEach(cat => {
      const option = document.createElement("div");
      option.className = "category-option";
      option.textContent = cat;
      if (selected.has(cat)) option.classList.add("selected");

      option.onclick = () => {
        if (selected.has(cat)) {
          selected.delete(cat);
          option.classList.remove("selected");
        } else {
          selected.add(cat);
          option.classList.add("selected");
        }
      };
      optionsContainer.appendChild(option);
    });

    if (!allCategories.includes(filter) && filter.trim() !== "") {
      const createOption = document.createElement("div");
      createOption.className = "category-option";
      createOption.textContent = `➕ Create "${filter}"`;
      createOption.onclick = () => {
        selected.add(filter);
        renderOptions(""); // rerender all and highlight new
      };
      optionsContainer.appendChild(createOption);
    }
  }

  input.addEventListener("input", () => renderOptions(input.value));
  renderOptions();

  saveBtn.onclick = async () => {
    const { data: current, error } = await supabase
      .from("item_types")
      .select("categories")
      .eq("id", itemId)
      .single();

    const updated = Array.from(new Set([...(current.categories || []), ...selected]));

    await supabase.from("item_types").update({ categories: updated }).eq("id", itemId);
    dropdown.remove();
    activeDropdown = null;

    await fetchStockItems();
    const filtered = getFilteredItems();
    applySortAndRender(filtered);
    updateFilterChips(getActiveFilters());
  };

  document.body.appendChild(dropdown);
  const rect = anchorElement.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
  dropdown.style.left = `${rect.left + window.scrollX}px`;

  activeDropdown = dropdown;

  // ✅ Click outside to close
  setTimeout(() => {
    document.addEventListener("click", closeDropdownOnOutsideClick);
  }, 0);

  function closeDropdownOnOutsideClick(e) {
    if (!dropdown.contains(e.target) && e.target !== anchorElement) {
      dropdown.remove();
      document.removeEventListener("click", closeDropdownOnOutsideClick);
      activeDropdown = null;
    }
  }
}

function getChipColor(label) {
  const hash = [...label].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const options = ["blue", "green", "purple", "gold", "gray"];
  return options[hash % options.length];
}


function getURLParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function updateURLFromForm() {
  const form = document.getElementById("filter-form");
  const formData = new FormData(form);
  const selectedCats = [...document.querySelectorAll(".dropdown-option.selected")].map(el => el.dataset.cat);
  const matchAll = document.getElementById("match-all-toggle")?.checked;

  const parseOrNull = (val) => {
    const trimmed = typeof val === "string" ? val.trim() : val;
    return trimmed === "" || trimmed === null ? null : parseFloat(trimmed);
  };
  const params = new URLSearchParams();

  for (const [key, value] of formData.entries()) {
    if (value) params.set(key, value);
  }

  if (selectedCats.length > 0) params.set("categories", selectedCats.join(","));
  if (matchAll) params.set("matchAll", "true");

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
  populateCategoryDropdown(data);
  setupFilters();
  setupToggle();
  setupClearFilters();
  setupCSVExport();
  setupPDFExport();
  applySortAndRender(data); // renders based on default sort

}

function populateDropdowns(data) {
  const qrTypeSelect = document.querySelector("select[name='qr_type']");
  const categories = new Set();
data.forEach(item => (item.categories || []).forEach(cat => categories.add(cat)));

const dropdownMenu = document.getElementById("category-dropdown-menu");
const dropdownToggle = document.getElementById("category-dropdown-toggle");

dropdownMenu.innerHTML = ""; // Clear existing
dropdownToggle.onclick = () => {
  dropdownMenu.classList.toggle("show");
};

// Close when clicking outside
document.addEventListener("click", (e) => {
  if (!dropdownMenu.contains(e.target) && e.target !== dropdownToggle) {
    dropdownMenu.classList.remove("show");
  }
});

// Build category checkboxes
[...categories].forEach(cat => {
  const wrapper = document.createElement("label");
  wrapper.className = "dropdown-option";
  wrapper.innerHTML = `<span>${cat}</span>`;
wrapper.dataset.cat = cat;
wrapper.addEventListener("click", () => {
  wrapper.classList.toggle("selected");
  currentPage = 1;
  const filtered = getFilteredItems();
  applySortAndRender(filtered);
  updateFilterChips(getActiveFilters());
  updateURLFromForm();
});

  dropdownMenu.appendChild(wrapper);
});

// Listen for changes
dropdownMenu.querySelectorAll(".category-checkbox").forEach(cb => {
  cb.addEventListener("change", () => {
    currentPage = 1;
    const filtered = getFilteredItems();
    applySortAndRender(filtered);
    updateFilterChips(getActiveFilters());
    updateURLFromForm();
  });
});

  
}


function populateCategoryDropdown(data) {
  const select = document.getElementById("bulk-category");
  const categories = [...new Set(data.map(item => item.category).filter(Boolean))];

  for (const cat of categories) {
    const option = document.createElement("option");
    option.value = cat;
    option.textContent = cat;
    select.appendChild(option);
  }

  const customOption = document.createElement("option");
  customOption.value = "__new__";
  customOption.textContent = "➕ New Category...";
  select.appendChild(customOption);

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
    categories: [...document.querySelectorAll(".dropdown-option.selected")].map(el => el.dataset.cat),
    qr_type: formData.get("qr_type"),
  };

  const matchAll = document.getElementById("match-all-toggle")?.checked;

  return allItems.filter(item => {
    const matchesCategory = filters.categories.length === 0 ? true :
      matchAll
        ? filters.categories.every(fCat => (item.categories || []).includes(fCat))
        : filters.categories.some(fCat => (item.categories || []).includes(fCat));

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
           (!filters.qr_type || item.qr_type === filters.qr_type) &&
           matchesCategory &&
           (showOnlyFavorites ? userFavorites.has(item.id) : true);
  });
}


function getActiveFilters() {
  const form = document.getElementById("filter-form");
  const formData = new FormData(form);

  const normalizeDate = (val) => {
    const parsed = new Date(val);
    return isNaN(parsed) ? null : parsed.toISOString().split("T")[0];
  };
  const parseOrNull = (val) => {
    const trimmed = typeof val === "string" ? val.trim() : val;
    return trimmed === "" || trimmed === null ? null : parseFloat(trimmed);
  };

  return {
    title: formData.get("title")?.toLowerCase(),
    description: formData.get("description")?.toLowerCase(),
    barcode: formData.get("barcode")?.toLowerCase(),
    distributor: formData.get("distributor")?.toLowerCase(),
    weightMin: parseOrNull(formData.get("weightMin")),
    weightMax: parseOrNull(formData.get("weightMax")),
    costMin: parseOrNull(formData.get("costMin")),
    costMax: parseOrNull(formData.get("costMax")),
    priceMin: parseOrNull(formData.get("priceMin")),
    priceMax: parseOrNull(formData.get("priceMax")),
    stockMin: parseOrNull(formData.get("stockMin")),
    stockMax: parseOrNull(formData.get("stockMax")),
    createdFrom: normalizeDate(formData.get("createdFrom")),
    createdTo: normalizeDate(formData.get("createdTo")),
    categories: [...document.querySelectorAll(".dropdown-option.selected")].map(el => el.dataset.cat),
    qr_type: formData.get("qr_type")
  };
}

function setupFilters() {
  const form = document.getElementById("filter-form");
  const inputs = form.querySelectorAll("input, select");

  inputs.forEach(input => {
    input.addEventListener("input", () => {
      currentPage = 1;
      const filtered = getFilteredItems();
      const filters = getActiveFilters(); // ✅ NEW
      applySortAndRender(filtered);
      updateFilterChips(filters); // ✅ CORRECT
      updateURLFromForm();
    });
  });

  document.getElementById("sort-select").addEventListener("change", () => {
    currentPage = 1;
    const filtered = getFilteredItems();
    const filters = getActiveFilters(); // ✅ NEW
    applySortAndRender(filtered);
    updateFilterChips(filters); // ✅ CORRECT
    updateURLFromForm();
  });

  document.getElementById("cards-per-page").addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value);
    currentPage = 1;
    const filtered = getFilteredItems();
    const filters = getActiveFilters(); // ✅ NEW
    applySortAndRender(filtered);
    updateFilterChips(filters); // ✅ CORRECT
    updateURLFromForm();
  });

  document.getElementById("show-favorites-only").addEventListener("change", (e) => {
    showOnlyFavorites = e.target.checked;
    const filtered = getFilteredItems();
    applySortAndRender(filtered);
    updateFilterChips(getActiveFilters());
  });
}


function setupClearFilters() {
  const form = document.getElementById("filter-form");
  const clearBtn = document.getElementById("clear-filters");

  clearBtn.addEventListener("click", () => {
    form.reset();
    applySortAndRender(allItems);
    updateFilterChips({});  // 🧼 Clear chips visually
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

async function toggleFavorite(itemId) {
  if (!currentUser) return;

  const isFav = userFavorites.has(itemId);
  const { error } = isFav
    ? await supabase.from("favorites").delete().eq("user_id", currentUser.id).eq("item_id", itemId)
    : await supabase.from("favorites").insert([{ user_id: currentUser.id, item_id: itemId }]);

  if (!error) {
    if (isFav) {
      userFavorites.delete(itemId);
    } else {
      userFavorites.add(itemId);
    }
    renderStockItems(getFilteredItems());
  }
}

function toggleSelectItem(itemId, checked) {
  if (checked) {
    selectedItems.add(itemId);
  } else {
    selectedItems.delete(itemId);
  }
  updateBulkToolbar();
  renderStockItems(getFilteredItems());
}

function updateBulkToolbar() {
  const toolbar = document.getElementById("bulk-toolbar");
  const count = document.getElementById("selected-count");
  const selectedCount = selectedItems.size;

  count.textContent = `${selectedCount} selected`;
  toolbar.classList.toggle("hidden", selectedCount === 0);
}

function clearSelectionAndRefresh() {
  selectedItems.clear();
  updateBulkToolbar();
  renderStockItems(getFilteredItems());
}

document.getElementById("bulk-favorite").addEventListener("click", async () => {
  if (!currentUser || selectedItems.size === 0) return;
  showLoading();
  const updates = [];

  for (const id of selectedItems) {
    const isFav = userFavorites.has(id);
    if (isFav) {
      updates.push(
        supabase.from("favorites").delete().eq("item_id", id).eq("user_id", currentUser.id)
      );
      userFavorites.delete(id);
    } else {
      updates.push(
        supabase.from("favorites").insert({ item_id: id, user_id: currentUser.id })
      );
      userFavorites.add(id);
    }
  }

  await Promise.all(updates);

  // Re-render view
  const updatedCount = selectedItems.size;
  clearSelectionAndRefresh();
  updateFilterChips(getActiveFilters());
  showToast(`⭐ Updated ${updatedCount} favorites`);
  hideLoading();
});

document.getElementById("bulk-category").addEventListener("change", async (e) => {
  let category = e.target.value;
  if (!category || selectedItems.size === 0) return;

  if (category === "__new__") {
    const userInput = prompt("Enter a new category:");
    if (!userInput) return;
  
    category = userInput;
  
    // ✅ Add new category to dropdown
    const select = document.getElementById("bulk-category");
    const exists = [...select.options].some(opt => opt.value === category);
  
    if (!exists) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.insertBefore(option, select.lastElementChild); // insert above “➕ New Category...”
      select.value = category; // keep it selected
    }
  }
  showLoading();
  const updates = [];

  for (const id of selectedItems) {
    updates.push(
      supabase.from("item_types").update({ category }).eq("id", id)
    );
  }

  await Promise.all(updates);

  const { data, error } = await supabase.from("item_types").select("*");
  if (error) return console.error("Error refreshing items:", error);

  allItems = data;
  populateCategoryDropdown(data);

  const updatedCount = selectedItems.size;

  clearSelectionAndRefresh();
  updateFilterChips(getActiveFilters());
  showToast(`📂 Moved ${updatedCount} items to “${category}”`);
  
  hideLoading();
});

function renderStockItems(data) {
  const grid = document.getElementById("stock-container");
  grid.innerHTML = "";

  data.forEach((item, index) => {
    const card = document.createElement("div");
    const isFavorited = currentUser && userFavorites.has(item.id);
    const isSelected = selectedItems.has(item.id);
    card.className = "stock-card";
    if (isFavorited) card.classList.add("favorited");
    if (isSelected) card.classList.add("selected");
    card.style.position = "relative";


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

    const checkboxHTML = `
      <input type="checkbox" class="select-checkbox" ${isSelected ? "checked" : ""} onchange="toggleSelectItem('${item.id}', this.checked)">
    `;

    const favoriteBtn = currentUser
  ? `<button class="favorite-btn" data-id="${item.id}" onclick="toggleFavorite('${item.id}')">${userFavorites.has(item.id) ? '★' : '☆'}</button>`
  : '';
  
      
    card.innerHTML = `
        <div class="stock-image-container">
          ${photoCarousel}
          <div class="card-float-controls">
            ${checkboxHTML}
            ${favoriteBtn}
          </div>
        </div>
        <div class="stock-content">
        <h2>${item.title}</h2>
        <p>${item.description}</p>
        <p><strong>Weight:</strong> ${item.weight}</p>
        <p><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>
        <p><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>
        <p><strong>Distributor:</strong> ${item.distributor_name || "—"}<br/>${item.distributor_phone || ""}</p>
        <p><strong>Notes:</strong> ${item.distributor_notes || "—"}</p>
        <p><strong>QR Type:</strong> ${item.qr_type}</p>
        <p><strong>Barcode:</strong> ${item.barcode || "—"}</p>
        <p class="stock-count ${stockClass}">In Stock: ${stock}</p>
        <p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>
        <p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>
        <div class="category-chips">
          ${(item.categories || []).map(cat => {
            const color = getChipColor(cat);
            return `<div class="category-chip" data-color="${color}">
              ${cat}
              <button onclick="removeCategory('${item.id}', '${cat}')">&times;</button>
            </div>`;
          }).join("")}        
          <div class="add-category-chip" onclick="showCategoryDropdown('${item.id}', this)">+ Add Category</div>
        </div>
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
  currentUser = (await supabase.auth.getUser()).data.user;
  if (currentUser) {
    const { data: favs } = await supabase
      .from("favorites")
      .select("item_id")
      .eq("user_id", currentUser.id);
    userFavorites = new Set(favs.map(f => f.item_id));
  }

  await fetchStockItems();
  
  applyFiltersFromURL();
  const filtered = getFilteredItems();
  const filters = getActiveFilters();
  applySortAndRender(filtered);
  updateFilterChips(filters);

  // ✅ Bulk Toolbar Listeners
  document.getElementById("bulk-clear").addEventListener("click", () => {
    clearSelectionAndRefresh();
    showToast(`✅ Cleared selection`);

  });

  document.getElementById("bulk-delete").addEventListener("click", async () => {
    if (selectedItems.size === 0) return;
    showLoading();
    const idsToDelete = Array.from(selectedItems);
    const { error } = await supabase
      .from("item_types")
      .delete()
      .in("id", idsToDelete);
    if (!error) {
      await fetchStockItems();

      const updatedCount = selectedItems.size;
      
      clearSelectionAndRefresh();
      updateFilterChips(getActiveFilters());
      showToast(`🗑 Deleted ${updatedCount} items`);
      hideLoading();
    }
  });

  document.getElementById("bulk-export").addEventListener("click", () => {
    const exportCards = Array.from(document.querySelectorAll(".stock-card"))
      .filter(card => {
        const id = card.querySelector(".select-checkbox")?.getAttribute("onchange")?.match(/'(.*?)'/)?.[1];
        return selectedItems.has(id);
      });
    if (exportCards.length === 0) return;
    exportCardsToCSV(exportCards);
  });
});



