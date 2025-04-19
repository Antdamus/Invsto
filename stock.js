// 🔹 Global App State
let currentPage = 1;                    // Current page number for pagination
let itemsPerPage = 12;                 // Number of items per page
let allItems = [];                     // Holds all fetched stock items
let userFavorites = new Set();         // Set of favorite item IDs for the current user
let currentUser = null;                // Holds authenticated user info
let selectedItems = new Set();         // Tracks currently selected items for bulk actions
let showOnlyFavorites = false;         // Flag to toggle "Show Only Favorites"
let activeDropdown = null;

//---------------------------------------------------------------//

/* ================= utilities ============================== */
//#region
// they are utililitieis be cause they are stateless, meaning they do not modify
// a global variable, they just get an input, and produce an output as simple as that
// can be tested independently by pasting them in other codes     

// 🔹 Toast Message Utility --> pop up message
function showToast(message) {
  const container = document.getElementById("toast-container"); // Target container
  //-> you are accessing the div id= toast container node in the DOM (document object model)
  const toast = document.createElement("div"); //this is creating a new div element
  //-> in memory, not in the DOM per se, just a standalone javascript object for now
  //remember the div is just a box
  //and in here toast is not an html id, rather is just a varible holding the pointer to the
  //the object
  toast.className = "toast"; //it just gave the div you created called toast a class name
  toast.textContent = message; //injects the message into the container
  //<div class="toast">Item added!</div>
  container.appendChild(toast); //this is injecting the full javascript object into the 
  //node of the the DOM so now the user can see it live 
  // <div id="toast-container">
  //   <div class="toast">📦 Your toast message</div>
  // </div>

  // Remove toast after 4 seconds
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// 🔹 Fetch unique, non-null values from any column in any Supabase table //
// ✅ Returns an array of cleaned, unique values
// ✅ Safe for reuse across different features (e.g., categories, brands, types, etc.)
async function fetchUniqueValues({ table, column }) {
  // Validate input
  if (!table || !column) {
    console.error("fetchUniqueValues: 'table' and 'column' are required");
    return [];
  }

  // Query Supabase for the desired column
  const { data, error } = await supabase.from(table).select(column);

  // Handle errors gracefully
  if (error) {
    console.error(`Error loading ${column} from ${table}:`, error);
    return [];
  }

  // Clean the data: remove nulls, extract values, remove duplicates
  const values = data.map(row => row[column]).filter(Boolean);
  const unique = [...new Set(values)];

  return unique;
}

// 🔸 Parse a string or value, return null if blank or invalid
const parseOrNull = (val) => {
  const trimmed = typeof val === "string" ? val.trim() : val;
  return trimmed === "" || trimmed === null ? null : parseFloat(trimmed);
};

// 🔸 Utility to format date into "YYYY-MM-DD" or return null
const normalizeDate = (val) => {
  const parsed = new Date(val);
  return isNaN(parsed) ? null : parsed.toISOString().split("T")[0];
};

// 🔹 Utility Function: Fetch all inventory items from Supabase item-types
// ✅ Returns: An array of item objects from the "item_types" table
// ✅ Usage: Server or client-side logic can call this to get item data
// ✅ Side-effect-free: Doesn't modify state or interact with the DOM
async function fetchStockItems() {
  // 🔸 Perform a SELECT query on the "item_types" table in Supabase
  // This fetches *all* columns (fields) for each item
  const { data, error } = await supabase.from("item_types").select("*");

  // ⚠️ If Supabase returns an error, log it to the console
  // Return an empty array so downstream logic doesn't break
  if (error) {
    console.error("Error loading stock items:", error.message);
    return [];
  }

  // ✅ If successful, return the full array of items
  return data;
}

// 🔹 Utility Function: sortItems(data, sortValue)
// ✅ Purpose: Returns a sorted copy of the provided data array
// ✅ Parameters:
//    - data: an array of item objects to be sorted
//    - sortValue: a string in the format "field-direction" (e.g., "title-asc")
// ✅ Behavior: 
//    - If sortValue is empty or invalid, returns the unsorted data
//    - Sorts based on supported fields and ascending/descending direction
// ✅ Output: a new sorted array (does NOT modify the original)
function sortItems(data, sortValue) {
  // If no sort option is selected, return a shallow copy (unsorted)
  if (!sortValue) return [...data];

  // Parse the field to sort by and the direction (asc or desc)
  const [field, direction] = sortValue.split("-");
  const isAsc = direction === "asc";

  // Create and return a new sorted array
  return [...data].sort((a, b) => {
    let valA, valB;

    switch (field) {
      // 🔠 String-based sorting (case-insensitive alphabetical)
      case "title":
        valA = (a.title || "").toLowerCase();
        valB = (b.title || "").toLowerCase();
        return isAsc
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);

      // 🔢 Numeric sorting (e.g., weight, cost, price, stock)
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

      // 🗓 Date sorting using ISO strings (e.g., creation date)
      case "date":
        valA = new Date(a.created_at);
        valB = new Date(b.created_at);
        break;

      // ❓ Unknown field: do not sort
      default:
        return 0;
    }

    // 🔁 Final numeric/date comparison result
    return isAsc ? valA - valB : valB - valA;
  });
}

// 🔹 Utility: Creates and appends a pagination button to a container
// ✅ Parameters:
//   - label: text content of the button (e.g., "Next »")
//   - page: page number to assign to currentPage
//   - isActive: whether this is the current page (for styling)
//   - container: DOM element to append the button into
function addBtn(label, page, isActive, container) {
  const btn = document.createElement("button");
  btn.type = "button"; // prevent accidental form submissions
  btn.textContent = label;

  if (isActive) btn.classList.add("active");

  btn.addEventListener("click", () => {
    currentPage = page;
    const filtered = getFilteredItems(allItems); // ✅ Fix: pass the full dataset
    applySortAndRender(filtered);
    updateURLFromForm();
  });

  container.appendChild(btn);
}

// 🔹 Utility: Create a single filter chip element with remove functionality
function createFilterChip(label, key) {
  const chip = document.createElement("div");
  chip.className = "filter-chip";
  chip.innerHTML = `${label} <button data-key="${key}">&times;</button>`;

  chip.querySelector("button").addEventListener("click", () => {
    chip.classList.add("removing");

    setTimeout(() => {
      if (key === "categories") {
        document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el => {
          if (el.dataset.cat === label.split(": ")[1]) {
            el.classList.remove("selected");
          }
        });
        
      } else if (key === "qr_type") {
        document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el => {
          if (el.dataset.qr === label.split(": ")[1]) {
            el.classList.remove("selected");
          }
        });
      } else {
        const input = document.querySelector(`[name="${key}"]`);
        if (input) input.value = "";
      }

      currentPage = 1;
      const filtered = getFilteredItems(allItems); // ✅ Pass the full dataset
      applySortAndRender(filtered);
      updateFilterChips(getActiveFilters());
      updateURLFromForm(); // ✅ Update URL so the chip stays removed on refresh
    }, 200);
  });

  return chip;
}


// 🔹 Utility: Extract Filter Values from Form and UI
// ✅ Used by both `getActiveFilters()` and `getFilteredItems()` to avoid duplication
// ✅ Pulls values from form fields and selected categories
function extractFilterValues() {
  const form = document.getElementById("filter-form");
  const formData = new FormData(form);

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

    categories: [...document.querySelectorAll(".dropdown-option.selected[data-cat]")]
      .map(el => el.dataset.cat)
      .filter(Boolean),
    qr_type: [...document.querySelectorAll('.dropdown-option.selected[data-qr]')].map(el => el.dataset.qr)

  };
}

// 🔹 UI Utility: Show loading overlay (or any spinner by selector)
// ✅ Adds a `.show` class to the target element
// ✅ Default selector is "#loading-overlay"
// ✅ Will silently fail if element not found
function showLoading(selector = "#loading-overlay") {
  const el = document.querySelector(selector);         // 🔍 Try to find the element
  if (el) el.classList.add("show");                    // ✅ Add .show class to make it visible
  // If no element is found, do nothing (safe fail)
}

// 🔹 UI Utility: Hide loading overlay (or any spinner by selector)
// ✅ Removes the `.show` class from the target element
// ✅ Will not error if element is missing
function hideLoading(selector = "#loading-overlay") {
  const el = document.querySelector(selector);         // 🔍 Try to find the element
  if (el) el.classList.remove("show");                 // ✅ Remove .show class to hide it
}

// 🔧 Utility to update item categories in Supabase
async function updateItemCategories(itemId, newCategories) {
  const { error } = await supabase
    .from("item_types")
    .update({ categories: newCategories })
    .eq("id", itemId);

  if (error) throw new Error(error.message);
}

// 🔸 Helper: Create a category option DOM element
function createCategoryOption(label, isSelected, onClick) {
  const option = document.createElement("div");
  option.className = "category-option";
  option.textContent = label;
  if (isSelected) option.classList.add("selected");
  option.onclick = onClick;
  return option;
}

// 🔸 Helper: Position a dropdown element below an anchor
function positionDropdown(dropdown, anchorElement) {
  const rect = anchorElement.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
  dropdown.style.left = `${rect.left + window.scrollX}px`;
}

// 🔸 Helper: Close dropdown when clicking outside of it
function setupClickOutsideToClose(dropdown, anchorElement, clearCallback) {
  function handleClick(e) {
    if (!dropdown.contains(e.target) && e.target !== anchorElement) {
      dropdown.remove();
      document.removeEventListener("click", handleClick);
      clearCallback?.();
    }
  }
  setTimeout(() => document.addEventListener("click", handleClick), 0);
}

// 🔸 helped to get chip colors
function getChipColor(label) {
  const hash = [...label].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const options = ["blue", "green", "purple", "gold", "gray"];
  return options[hash % options.length];
}

// helper to get URL parameters
function getURLParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/** 🔧 Extract unique values from an array-type column in a dataset
 * @param {Array} data - Your dataset (array of objects)
 * @param {string} key - The field name you want to extract from (e.g., "categories")
 * @returns {Array} - Array of unique values from that column
 */
function extractUniqueFromArrayColumn(data, column) {
  const uniqueSet = new Set();

  data.forEach(item => {
    let values = item[column];

    if (typeof values === "string") {
      values = [values]; // Wrap single string in array
    } else if (!Array.isArray(values)) {
      values = []; // Ignore invalid types
    }

    values.forEach(val => {
      if (typeof val === "string" && val.trim() !== "") {
        uniqueSet.add(val.trim());
      }
    });
  });

  return Array.from(uniqueSet);
}



// 🔧 Utility: Attaches dropdown toggle logic to a trigger element
// ✅ Accepts: toggle button ID and dropdown menu ID
// ✅ Adds toggle show/hide behavior and outside-click closing
function setupDropdownToggle(toggleId, menuId) {
  const toggle = document.getElementById(toggleId);
  const menu = document.getElementById(menuId);
  if (!toggle || !menu) return;

  // ✅ Toggle dropdown on click
  toggle.onclick = () => {
    menu.classList.toggle("show");
  };

  // ✅ Close dropdown if user clicks outside
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== toggle) {
      menu.classList.remove("show");
    }
  });
}

// 🔧 Utility: Extract unique non-null values from a specified column in a dataset
// ✅ Parameters:
//    - data: array of objects (e.g., inventory items)
//    - column: the key to extract from each object (e.g., "category", "brand")
// ✅ Returns:
//    - an array of deduplicated, non-null string values
function extractUniqueFromColumn(data, column) {
  if (!Array.isArray(data) || !column) {
    console.warn("extractUniqueFromColumn: Invalid input.");
    return [];
  }

  const values = data.map(item => item[column]).filter(Boolean);
  return [...new Set(values)]; // Deduplicate
}

// 🔹 Utility: Populates a <select> dropdown with <option> tags from an array
// ✅ Parameters:
//    - selectId: string ID of the <select> element in the DOM
//    - optionsArray: array of string values to inject as <option>
//    - includeNewOption: whether to append a "New..." custom entry at the end
function populateSelectOptions(selectId, optionsArray, includeNewOption = false) {
  const select = document.getElementById(selectId);

  if (!select) {
    console.warn(`populateSelectOptions: No <select> found with ID "${selectId}"`);
    return;
  }

  // 🧼 Clear existing <option> entries
  select.innerHTML = "";

  // 🔁 Inject options from array
  optionsArray.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });

  // ➕ Optional: Add "New..." entry for dynamic category creation
  if (includeNewOption) {
    const customOption = document.createElement("option");
    customOption.value = "__new__";
    customOption.textContent = "➕ New Category...";
    select.appendChild(customOption);
  }
}

// 🔧 Utility: Setup toggle behavior for any button and target element
// ✅ Parameters:
//   - toggleId: ID of the button that will trigger the toggle
//   - targetId: ID of the element to show/hide
//   - showLabel: (Optional) Text to show when visible
//   - hideLabel: (Optional) Text to show when hidden
function setupToggleBehavior(toggleId, targetId, showLabel = "❌ Hide", hideLabel = "🔍 Show") {
  // 🔍 Get the button element using its ID
  const toggleBtn = document.getElementById(toggleId);

  // 🔍 Get the target element that should be shown/hidden
  const target = document.getElementById(targetId);

  // ⚠️ Exit early if either element wasn't found in the DOM
  if (!toggleBtn || !target) {
    console.warn("setupToggleBehavior: Invalid IDs provided.");
    return;
  }

  // ⏰ Attach click event to the toggle button
  toggleBtn.addEventListener("click", () => {
    // ◼ Toggle the "show" class on the target element
    const isShown = target.classList.toggle("show");

    // ✅ Update the button label depending on visibility state
    toggleBtn.textContent = isShown ? showLabel : hideLabel;
  });
}

// 🔧 Utility: Sets up live filtering, sorting, pagination, and favorites
// ✅ Attaches listeners to input elements in a filter form
// ✅ When inputs change, it re-runs:
//     - Filtering
//    - Sorting
//    - Pagination
//    - Filter chip update
//    - URL sync
//
 // @param {string} formId - ID of the filter form (e.g. "filter-form")
//  @param {string[]} additionalIds - Extra elements to listen to e.g. sort or pagination
function setupDynamicFilters(formId, additionalIds = []) {
 const form = document.getElementById(formId);
 if (!form) return; // 🛑 If form not found, exit safely

 // 🔁 Central handler to refilter, re-render, update UI + URL
 const handleFilterChange = () => {
   currentPage = 1;                                // Reset to page 1
   const filtered = getFilteredItems(allItems);    // Apply filter logic to all items
   const filters = getActiveFilters();             // Extract latest filter values
   applySortAndRender(filtered);                   // Sort + paginate + display
   updateFilterChips(filters);                     // Show visual filter chips
   updateURLFromForm();                            // Push state to URL bar
 };

 // 🔁 Attach input and select listeners inside the form
 const inputs = form.querySelectorAll("input, select");
 inputs.forEach(input => {
   input.addEventListener("input", handleFilterChange); // Every change re-filters
 });

 // 🔁 Handle extra dropdowns like sort and cards-per-page
 additionalIds.forEach(id => {
   const el = document.getElementById(id);
   if (!el) return;

   el.addEventListener("change", (e) => {
     if (id === "cards-per-page") {
       itemsPerPage = parseInt(e.target.value);    // Update items per page setting
     } else if (id === "sort-select") {
       currentPage = 1;                            // Reset page on sort
     }
     handleFilterChange();                         // Recalculate everything
   });
 });

 // 🔁 Favorites-only checkbox toggle
 const favToggle = document.getElementById("show-favorites-only");
 if (favToggle) {
   favToggle.addEventListener("change", (e) => {
     showOnlyFavorites = e.target.checked;         // Global toggle
     handleFilterChange();                         // Re-render with this applied
   });
 }
}

// 🔧 Modular Setup: Clear filters with a button
 // @param {string} buttonId - ID of the "Clear Filters" button
 // @param {string} formId - ID of the form to reset
function setupClearFilters(buttonId = "clear-filters", formId = "filter-form") {
  const button = document.getElementById(buttonId);
  const form = document.getElementById(formId);

  if (!button || !form) return;

  button.addEventListener("click", () => {
    // 🔹 Reset all input fields in the form
    form.reset();

    // 🔹 Deselect any selected category chips
    document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el =>
      el.classList.remove("selected")
    );
    document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el =>
      el.classList.remove("selected")
    );
    

    // 🔹 Reset pagination and re-apply filtering + rendering
    currentPage = 1;
    const filtered = getFilteredItems(allItems); 
    applySortAndRender(filtered);
    updateFilterChips(getActiveFilters());
    updateURLFromForm();
    showToast("🧼 Filters cleared!");
  });
}

/** 🔧 General Custom Dropdown Setup Utility
 * @param {string} toggleId - ID of the toggle <button>
 * @param {string} menuId - ID of the dropdown <ul> or <div> menu
 * @param {string} containerSelector - Selector for outer container (ID or class)
 * @param {string} selectId - (Optional) ID of native <select> element to sync
 * @param {function} onSelect - (Optional) callback function when an option is selected
 */
function setupCustomDropdown({ toggleId, menuId, containerSelector, selectId = null, onSelect = null }) {
  const toggle = document.getElementById(toggleId);
  const menu = document.getElementById(menuId);
  const container = document.querySelector(containerSelector);

  if (!toggle || !menu || !container) {
    console.warn("Dropdown setup failed. Missing elements:", { toggle, menu, container });
    return;
  }

  // 🔁 Toggle menu visibility
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("show");
    container.classList.toggle("active");
  });

  // 🔁 Handle option selection
  menu.querySelectorAll("li").forEach((optionEl) => {
    optionEl.addEventListener("click", () => {
      const selectedValue = optionEl.getAttribute("data-value");
      const selectedLabel = optionEl.textContent;

      // ✏️ Update toggle button label
      toggle.innerHTML = `${selectedLabel} <span class="material-icons">expand_more</span>`;

      // 🧪 Sync with native <select> if provided
      if (selectId) {
        const nativeSelect = document.getElementById(selectId);
        if (nativeSelect) {
          nativeSelect.value = selectedValue;
          nativeSelect.dispatchEvent(new Event("change"));
        }
      }

      // ✅ Custom callback if provided
      if (typeof onSelect === "function") {
        onSelect(selectedValue, selectedLabel);
      }

      // 🎬 Close dropdown
      menu.classList.remove("show");
      container.classList.remove("active");
    });
  });

  // 🧼 Close if user clicks outside
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) {
      menu.classList.remove("show");
      container.classList.remove("active");
    }
  });
}


// ================= Carousel Navigation Utilities =================

// 🔹 Move to next image in carousel for a given card
function nextSlide(index) {
  const carousel = document.getElementById(`carousel-${index}`);
  const track = carousel.querySelector(".carousel-track");
  const images = track.querySelectorAll(".carousel-photo");

  // 🔍 Find currently active image
  const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
  images[currentIndex].classList.remove("active");

  // 🔁 Move to next image (wrap around)
  const nextIndex = (currentIndex + 1) % images.length;
  images[nextIndex].classList.add("active");
}

// 🔹 Move to previous image in carousel for a given card
function prevSlide(index) {
  const carousel = document.getElementById(`carousel-${index}`);
  const track = carousel.querySelector(".carousel-track");
  const images = track.querySelectorAll(".carousel-photo");

  const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
  images[currentIndex].classList.remove("active");

  // 🔁 Move to previous image (wrap around)
  const prevIndex = (currentIndex - 1 + images.length) % images.length;
  images[prevIndex].classList.add("active");
}

// ================= URL-Driven Filter Initialization =================

// 🔹 Parses URL query string and pre-fills the filter form
function applyFiltersFromURL() {
  const params = getURLParams();               // ✅ Use existing utility
  const form = document.getElementById("filter-form");

  // 🔁 Populate inputs with URL param values
  for (const [key, value] of Object.entries(params)) {
    const input = form.querySelector(`[name="${key}"]`);
    if (input) input.value = value;
  }

  // 🧮 Page size
  if (params.limit) {
    itemsPerPage = parseInt(params.limit);
    document.getElementById("cards-per-page").value = params.limit;
  }

  // 📄 Page number
  if (params.page) currentPage = parseInt(params.page);

  // ↕ Sort option
  if (params.sort) document.getElementById("sort-select").value = params.sort;

  // 📂 Pre-select categories from URL (comma-separated list)
  if (params.categories) {
    const catSet = new Set(params.categories.split(","));
    document.querySelectorAll(".dropdown-option[data-cat]").forEach(el => {
      if (catSet.has(el.dataset.cat)) {
        el.classList.add("selected");
      }
    });
  }

  // 📂 Pre-select qr types from URL (comma-separated list)
  if (params.qr_type) {
    const qrSet = new Set(params.qr_type.split(","));
    document.querySelectorAll('.dropdown-option[data-qr]').forEach(el => {
      if (qrSet.has(el.dataset.qr)) {
        el.classList.add("selected");
      }
    });
  }

  // ☑ Match-all category toggle
  if (params.matchAll === "true") {
    const matchToggle = document.getElementById("match-all-toggle");
    if (matchToggle) matchToggle.checked = true;
  }
}

// 🔹 Closes category dropdown if user clicks outside of it
// ✅ Prevents dropdown staying open when focus lost
// ✅ Assumes presence of category-dropdown-container and category-dropdown-menu
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("category-dropdown-container");
  if (!dropdown.contains(e.target)) {
    document.getElementById("category-dropdown-menu").classList.remove("show");
  }
});

// 🔧 Utility: Update Filter Summary Bar
function updateFilterSummary(filteredItems, filters) {
  const summaryEl = document.getElementById("filter-summary");
  if (!summaryEl) return;

  const parts = [];
  const count = filteredItems.length;

  if (filters.title) parts.push(`title contains "${filters.title}"`);
  if (filters.description) parts.push(`description has "${filters.description}"`);
  if (Array.isArray(filters.qr_type) && filters.qr_type.length) {
    parts.push(`QR type: ${filters.qr_type.join(", ")}`);
  }
  if (filters.barcode) parts.push(`barcode = ${filters.barcode}`);
  if (filters.distributor) parts.push(`distributor = ${filters.distributor}`);

  if (filters.costMin !== null || filters.costMax !== null) {
    parts.push(`cost: ${filters.costMin ?? '–'} to ${filters.costMax ?? '–'}`);
  }
  if (filters.priceMin !== null || filters.priceMax !== null) {
    parts.push(`price: ${filters.priceMin ?? '–'} to ${filters.priceMax ?? '–'}`);
  }
  if (filters.stockMin !== null || filters.stockMax !== null) {
    parts.push(`stock: ${filters.stockMin ?? '–'} to ${filters.stockMax ?? '–'}`);
  }
  if (filters.createdFrom || filters.createdTo) {
    parts.push(`date: ${filters.createdFrom ?? '–'} to ${filters.createdTo ?? '–'}`);
  }

  if (Array.isArray(filters.categories)) {
    const cleaned = filters.categories.filter(Boolean);
    if (cleaned.length > 0) {
      parts.push(`categories: ${cleaned.join(", ")}`);
    }
  }

  const result = `🔎 Showing ${count} item${count !== 1 ? "s" : ""}${parts.length ? ` filtered by ${parts.join(", ")}` : ""}.`;

  summaryEl.textContent = result;
  summaryEl.classList.add("active");
}


//#endregion

//-------------------------------------------------------------------//

/* ================= Filtering Engine ========================= */
//#region
//be mindful that this might reference some rendering functions, utilites, etc.
// 🔹 Filtering Engine: Filters the `allItems` list based on current filter form inputs
// ✅ Reads values from the DOM form and selected filters
// ✅ Returns: a filtered array of items to be rendered in the grid
// 🔹 Applies all filters to a given list of items
function getFilteredItems(items) {
  const filters = extractFilterValues();
  const matchAll = document.getElementById("match-all-toggle")?.checked;
  console.log("matchstate:", matchAll);

  return items.filter(item => {
    const matchesCategory = filters.categories.length === 0 ? true :
      matchAll
        ? filters.categories.every(fCat => (item.categories || []).includes(fCat))
        : filters.categories.some(fCat => (item.categories || []).includes(fCat));

    return (
      (!filters.title || item.title?.toLowerCase().includes(filters.title)) &&
      (!filters.description || item.description?.toLowerCase().includes(filters.description)) &&
      (!filters.barcode || item.barcode?.toLowerCase().includes(filters.barcode)) &&
      (!filters.distributor || item.distributor_name?.toLowerCase().includes(filters.distributor)) &&

      (filters.weightMin !== null ? item.weight >= filters.weightMin : true) &&
      (filters.weightMax !== null ? item.weight <= filters.weightMax : true) &&
      (filters.costMin !== null ? item.cost >= filters.costMin : true) &&
      (filters.costMax !== null ? item.cost <= filters.costMax : true) &&
      (filters.priceMin !== null ? item.sale_price >= filters.priceMin : true) &&
      (filters.priceMax !== null ? item.sale_price <= filters.priceMax : true) &&
      (filters.stockMin !== null ? Number(item.stock || 0) >= filters.stockMin : true) &&
      (filters.stockMax !== null ? Number(item.stock || 0) <= filters.stockMax : true) &&

      (!filters.createdFrom || item.created_at >= filters.createdFrom) &&
      (!filters.createdTo || item.created_at <= filters.createdTo) &&
      (filters.qr_type.length === 0 || filters.qr_type.includes(item.qr_type)) &&
      matchesCategory &&
      (showOnlyFavorites ? userFavorites.has(item.id) : true)
    );
  });
}


//#endregion

//-------------------------------------------------------------------//

/* ================= User Interface Rendering Functions ============= */
//#region
// 🔹 UI Renderer: renderStockItems(data)
//#region
// 🔹 UI Renderer: renderStockItems(data)
// Safely renders item cards using modular components and delegated event listeners
function renderStockItems(data) {
  const grid = document.getElementById("stock-container");
  grid.innerHTML = "";

  const fragment = document.createDocumentFragment();

  data.forEach((item, index) => {
    const card = renderStockCard(item, index);
    fragment.appendChild(card);
  });

  grid.appendChild(fragment);
}

// 🔹 Builds one full card element
function renderStockCard(item, index) {
  const card = document.createElement("div");
  card.className = "stock-card";
  card.style.position = "relative";
  card.dataset.itemId = item.id; // useful for event delegation

  const isFavorited = currentUser && userFavorites.has(item.id);
  const isSelected = selectedItems.has(item.id);
  if (isFavorited) card.classList.add("favorited");
  if (isSelected) card.classList.add("selected");

  const photoCarousel = buildCarousel(item.photos || [], index);
  const floatControls = buildFloatControls(item.id, isSelected, isFavorited);
  const content = buildCardContent(item);

  card.innerHTML = `
    <div class="stock-image-container">
      ${photoCarousel}
      <div class="card-float-controls">${floatControls}</div>
    </div>
    ${content}
  `;

  return card;
}

// 🔹 Build image carousel or fallback if no photos
function buildCarousel(photos, index) {
  if (!photos.length) return `<div class="no-photo">No Photos</div>`;

  return `
    <div class="carousel" id="carousel-${index}">
      <button class="carousel-btn left" data-carousel-index="${index}" data-dir="prev">&#10094;</button>
      <div class="carousel-track">
        ${photos.map((photo, i) => `
          <img src="${photo}" class="carousel-photo ${i === 0 ? 'active' : ''}" />
        `).join('')}
      </div>
      <button class="carousel-btn right" data-carousel-index="${index}" data-dir="next">&#10095;</button>
    </div>
  `;
}

// 🔹 Build checkbox and favorite button section
function buildFloatControls(id, isSelected, isFavorited) {
  const checkbox = `
    <input type="checkbox" class="select-checkbox" data-id="${id}" ${isSelected ? "checked" : ""}>
  `;

  const favoriteBtn = currentUser
    ? `<button class="favorite-btn" data-id="${id}">
         ${isFavorited ? '★' : '☆'}
       </button>`
    : '';

  return checkbox + favoriteBtn;
}

// 🔹 Build the full card body with data-driven text content and chips
function buildCardContent(item) {
  const stock = typeof item.stock === "number" ? item.stock : 0;
  const stockClass = stock === 0 ? "stock-zero" : "";

  const categoryChips = (item.categories || []).map(cat => {
    const color = getChipColor(cat);
    return `
      <div class="category-chip" data-color="${color}" data-cat="${cat}" data-id="${item.id}">
        ${cat}
        <button class="remove-category-btn">&times;</button>
      </div>
    `;
  }).join("");

  return `
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
        ${categoryChips}
        <div class="add-category-chip" data-id="${item.id}">+ Add Category</div>
      </div>
    </div>
  `;
}

// 🔹 Central event listener to handle all dynamic actions safely
// ✅ Uses event delegation to manage clicks and changes on any item card

document.addEventListener("click", (e) => {
  const id = e.target.dataset.id;

  if (e.target.matches(".favorite-btn")) {
    toggleFavorite(id);
  }

  if (e.target.matches(".add-category-chip")) {
    showCategoryDropdown(id, e.target);
  }

  if (e.target.matches(".remove-category-btn")) {
    const chip = e.target.closest(".category-chip");
    const cat = chip?.dataset.cat;
    const itemId = chip?.dataset.id;
    if (cat && itemId) removeCategory(itemId, cat);
  }

  if (e.target.matches(".carousel-btn")) {
    const index = parseInt(e.target.dataset.carouselIndex, 10);
    const dir = e.target.dataset.dir;
    if (!isNaN(index) && dir) {
      dir === "prev" ? prevSlide(index) : nextSlide(index);
    }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.matches(".select-checkbox")) {
    const id = e.target.dataset.id;
    toggleSelectItem(id, e.target.checked);
  }
});

//#endregion

// 🔹 UI Renderer: Pagination Controls
// ✅ Purpose: Dynamically builds and injects page navigation buttons
// ✅ Triggered after filtering or page changes
// ✅ Depends on: `currentPage` (global), `getFilteredItems()`, and `applySortAndRender()`
// 🔹 UI Controller: Pagination Buttons
// ✅ Depends on: `currentPage` (global), `getFilteredItems()`, `applySortAndRender()`
// Uses external utility addBtn
function renderPaginationControls(totalPages) {
  const container = document.getElementById("pagination-buttons");
  container.innerHTML = ""; // 🧹 Clear previous buttons

  // 🔸 If only one page or none, skip rendering anything
  if (totalPages <= 1) return;

  // 🔹 Add "Prev" button (if not on first page)
  if (currentPage > 1) {
    addBtn("« Prev", currentPage - 1, false, container);
  }

  // 🔁 Add a button for each page
  for (let i = 1; i <= totalPages; i++) {
    addBtn(i, i, i === currentPage, container);
  }

  // 🔹 Add "Next" button (if not on last page)
  if (currentPage < totalPages) {
    addBtn("Next »", currentPage + 1, false, container);
  }
}

// 🔹 UI Renderer: Filter Chips
// ✅ Displays current active filters as removable chips under the search bar
function updateFilterChips(filters) {
  const chipContainer = document.getElementById("filter-chips");
  if (!chipContainer) return;
  chipContainer.innerHTML = "";

  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === "") continue;

    let label = "";
    switch (key) {
      case "title":        label = `Title: "${value}"`; break;
      case "description":  label = `Description: "${value}"`; break;
      case "barcode":      label = `Barcode: ${value}`; break;
      case "distributor":  label = `Distributor: ${value}`; break;
      case "weightMin":    label = `Weight ≥ ${value}`; break;
      case "weightMax":    label = `Weight ≤ ${value}`; break;
      case "costMin":      label = `Cost ≥ ${value}`; break;
      case "costMax":      label = `Cost ≤ ${value}`; break;
      case "priceMin":     label = `Price ≥ ${value}`; break;
      case "priceMax":     label = `Price ≤ ${value}`; break;
      case "stockMin":     label = `Stock ≥ ${value}`; break;
      case "stockMax":     label = `Stock ≤ ${value}`; break;
      case "createdFrom":  label = `Created ≥ ${value}`; break;
      case "createdTo":    label = `Created ≤ ${value}`; break;

      case "categories":
        if (Array.isArray(value) && value.length && value.some(v => v)) {
          value.forEach(cat => {
            chipContainer.appendChild(createFilterChip(`Category: ${cat}`, "categories"));
          });
        }
        continue;

      case "qr_type":
        if (Array.isArray(value)) {
          value.forEach(qr => {
            chipContainer.appendChild(createFilterChip(`QR: ${qr}`, "qr_type"));
          });
        }
        continue;

      default: continue;
    }

    chipContainer.appendChild(createFilterChip(label, key));
  }
}

/**🔧 Smart Category Dropdown Renderer and searchbar with optional override
 * @param {Object} config
 * @param {string} config.menuId - ID of the container element
 * @param {Array<string>} config.options - Array of strings to render
 * @param {Array<Object>} config.items - Full dataset to filter
 * @param {string} config.optionClass - Class for each category block
 * @param {string} config.searchId - ID for the search input
 * @param {string} config.placeholder - Placeholder for the search box
 * @param {string} config.optionsContainerClass - Class around all options
 * @param {Function} [config.onSelect] - Optional custom handler
 */
function renderDropdownOptionsCustom({
  menuId,
  options = [],
  items = [],
  optionClass = "dropdown-option",
  searchId = "category-search",
  placeholder = "Search categories...",
  dataAttribute = "cat",
  optionsContainerClass = "dropdown-options-container",
  onSelect = null
}) {
  const menu = document.getElementById(menuId);
  if (!menu) return;

  // 🔁 Inject the search + options HTML into the container
  menu.innerHTML = `
    <input type="text" id="${searchId}" placeholder="${placeholder}">
    <div class="${optionsContainerClass}">
      ${options.map(opt => `
        <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
      `).join("")}
    </div>
  `;

  // ✅ Default handler (original behavior)
  const defaultSelectHandler = (value, el) => {
    el.classList.toggle("selected");
    currentPage = 1;
    const filtered = getFilteredItems(items);
    applySortAndRender(filtered);
    updateFilterChips(getActiveFilters());
    updateURLFromForm();
  };

  // 🔁 Setup click behavior for each option
  menu.querySelectorAll(`.${optionClass}`).forEach(optionEl => {
    optionEl.addEventListener("click", () => {
      const value = optionEl.dataset.value;
      if (typeof onSelect === "function") {
        onSelect(value, optionEl); // pass element too if caller wants it
      } else {
        defaultSelectHandler(value, optionEl);
      }
    });
  });

  // 🔍 Live filtering for search input
  const input = menu.querySelector(`#${searchId}`);
  const optionsContainer = menu.querySelector(`.${optionsContainerClass}`);

  if (input && optionsContainer) {
    input.addEventListener("input", (e) => {
      const search = e.target.value.toLowerCase();
      const filtered = options.filter(opt =>
        opt.toLowerCase().includes(search)
      );

      // Clear and inject just the filtered options
      optionsContainer.innerHTML = filtered.map(opt => `
        <div class="${optionClass}" data-cat="${opt}" data-value="${opt}">${opt}</div>
      `).join("");

      // Reattach click listeners
      optionsContainer.querySelectorAll(`.${optionClass}`).forEach(optionEl => {
        optionEl.addEventListener("click", () => {
          const value = optionEl.dataset.value;
          if (typeof onSelect === "function") {
            onSelect(value, optionEl);
          } else {
            optionEl.classList.toggle("selected");
            currentPage = 1;
            const filteredItems = getFilteredItems(items);
            applySortAndRender(filteredItems);
            updateFilterChips(getActiveFilters());
            updateURLFromForm();
          }
        });
      });
    });
  }

}


// 🔹 Category Loader: gets unique values and triggers dropdown
async function loadCategories(items) {
  try {
    const categories = await fetchUniqueValues({ table: "item-types", column: "category" });
    renderDropdownOptionsCustom({
      menuId: "category-dropdown-menu",
      options: categories,
      items: items, // required for default filter refresh
      optionClass: "dropdown-option", //class of each of the option items
      searchId: "category-search", //id of the search bar for costumization
      placeholder: "Search categories...", //what the search bar will say
      optionsContainerClass: "dropdown-options-container", //name of the container holding the options
    }); ; // explicitly pass both
  } catch (err) {
    console.error("Failed to load categories:", err.message);
  }
}

// 🔹 to re render a refreshed inventory
async function refreshInventoryUI() {
  const items = await fetchStockItems();
  const filtered = getFilteredItems(items);
  applySortAndRender(filtered);
  updateFilterChips(getActiveFilters());
}



//#endregion

//-------------------------------------------------------------------//

/* ================= Controller functions ============================== */ 
//#region
//functions that modify the DOM and orchestrate sometimes multiple utilities

// 🔹 Gets all current filter values for display as filter chips
function getActiveFilters() {
  return extractFilterValues();
}

// 🔹 UI Pagination Controller
// ✅ Purpose: Paginates and renders a specific slice of data based on the current page
// ✅ Accepts: 
//    - `data`: full array of items to paginate (filtered and/or sorted)
// ✅ Relies on global:
//    - `currentPage`: which page user is on
//    - `itemsPerPage`: how many items per page
// ✅ Triggers:
//    - `renderStockItems()`: shows the paginated items on screen
//    - `renderPaginationControls()`: updates the pagination buttons
function paginateAndRender(data) {
  // Total number of items and pages based on current page size
  const totalItems = data.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);

  // If the current page is too high (e.g. after filtering), reset to page 1
  if (currentPage > totalPages) currentPage = 1;

  // Calculate start and end indices for slicing the array
  const start = (currentPage - 1) * itemsPerPage;  // inclusive
  const end = start + itemsPerPage;               // exclusive

  // Extract only the items for this current page
  const paginatedItems = data.slice(start, end);

  // 🔁 Render those items into the grid or list
  renderStockItems(paginatedItems);

  // 🔁 Render the pagination controls (e.g. page buttons)
  renderPaginationControls(totalPages);
}

// 🔸 Load categories from Supabase and render dropdown in the
// filter interface
async function loadCategories() {
  const categories = await fetchUniqueValues({ table: "item-types", column: "category" });
  renderDropdownOptionsCustom({
    menuId: "category-dropdown-menu",
    options: categories,
    items: data, // required for default filter refresh
    optionClass: "dropdown-option", //class of each of the option items
    searchId: "category-search", //id of the search bar for costumization
    placeholder: "Search categories...", //what the search bar will say
    optionsContainerClass: "dropdown-options-container", //name of the container holding the options
  }); ;
}

// 🔸 Get sort value from DOM, sort the data, and render
function applySortAndRender(data) {
  const sortValue = document.getElementById("sort-select")?.value;
  const sorted = sortItems(data, sortValue);
  paginateAndRender(sorted);
  updateFilterSummary(sorted, getActiveFilters());
}

// 🔸 update the url with the current filters
function updateURLFromForm() {
  const form = document.getElementById("filter-form");
  const formData = new FormData(form); // 🔁 Get all input values

  // 🔸 Get selected categories from the dropdown UI
  const selectedCats = [...document.querySelectorAll(".dropdown-option.selected[data-cat]")]
    .map(el => el.dataset.cat);

  // 🔸 Match-all checkbox for categories
  const matchAll = document.getElementById("match-all-toggle")?.checked;

  // 🔸 Prepare the query string
  const params = new URLSearchParams();

  // 🔁 Add each non-empty field from the form to the URL params
  for (const [key, value] of formData.entries()) {
    if (value) params.set(key, value);
  }

  // 🔁 Add category filter (comma-separated string) if any are selected
  if (selectedCats.length > 0) {
    params.set("categories", selectedCats.join(","));
  }

  // 🔁 Add QR type filter (comma-separated string) if selected
    const selectedQRs = [...document.querySelectorAll(".dropdown-option.selected[data-qr]")]
    .map(el => el.dataset.qr);
    if (selectedQRs.length > 0) {
    params.set("qr_type", selectedQRs.join(","));
    }


  // ✅ Add match-all toggle if enabled
  if (matchAll) {
    params.set("matchAll", "true");
  }

  // ✅ Add current sort option
  const sortValue = document.getElementById("sort-select")?.value;
  if (sortValue) {
    params.set("sort", sortValue);
  }

  // ✅ Add cards-per-page limit if selected
  const limitValue = document.getElementById("cards-per-page")?.value;
  if (limitValue) {
    params.set("limit", limitValue);
  }

  // ✅ Always store the current page
  params.set("page", currentPage);

  // 🔄 Update the browser URL without reloading the page
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", newUrl);
}

// 🔸  add categories, remove them, apply them
//#region

// 🔹 Controller: Remove a category from a specific item in Supabase
// ✅ Steps:
//    1. Fetch the current categories for the item
//    2. Remove the given category from the list
//    3. Update the item in Supabase with the new list
//    4. Refresh the UI re-fetch re-filter re-render update chips
async function removeCategory(itemId, category) {
  const { data, error } = await supabase
    .from("item_types")
    .select("categories")
    .eq("id", itemId)
    .single();

  if (error || !data) {
    console.error("Error fetching item:", error);
    return;
  }

  // Remove the category from the list (filter it out)
  const updated = (data.categories || []).filter(cat => cat !== category);

  // Update item in Supabase
  await updateItemCategories(itemId, updated);

  // Refresh filtered + sorted UI
  await refreshInventoryUI();
}

// 🔹 Controller: Prompt user to type a new category and add it to an item
// ✅ Steps:
//    1. Prompt user for a new category (via `prompt()`)
//    2. Fetch existing categories from Supabase
//    3. Merge the new category with the list (using Set to avoid duplicates)
//    4. Update Supabase
//    5. Refresh the UI
async function addCategory(itemId) {
  const newCat = prompt("Enter new category:");
  if (!newCat) return;

  const { data, error } = await supabase
    .from("item_types")
    .select("categories")
    .eq("id", itemId)
    .single();

  if (error || !data) {
    console.error("Error fetching item:", error);
    return;
  }

  // Add new category using a Set to prevent duplicates
  const updated = Array.from(new Set([...(data.categories || []), newCat]));

  // Push update to Supabase
  await updateItemCategories(itemId, updated);

  // Refresh inventory list and filters
  await refreshInventoryUI();
}

// 🔹 Controller: Apply a selected category to an item (e.g., from dropdown)
// ✅ No user prompt — used for applying pre-existing category values
// ✅ Steps:
//    1. Fetch current item categories
//    2. Merge the selected category in (no duplicates)
//    3. Push update to Supabase
//    4. Refresh the UI
async function applyCategory(itemId, newCategory) {
  const { data, error } = await supabase
    .from("item_types")
    .select("categories")
    .eq("id", itemId)
    .single();

  if (error || !data) return;

  const updated = Array.from(new Set([...(data.categories || []), newCategory]));

  await updateItemCategories(itemId, updated);

  await refreshInventoryUI();
}


//#endregion


// 🔹 UI Controller: Show category dropdown for an item
// ✅ Allows selecting, creating, and assigning categories to an item in-place
// ✅ Refactored to use modular utilities and clean logic
async function showCategoryDropdown(itemId, anchorElement) {
  // 🧹 Ensure only one dropdown is open at a time
  if (activeDropdown) activeDropdown.remove();

  // 🔸 Fetch all unique category values using the utility
  const allCategories = await fetchUniqueValues({
    table: "item_types",
    column: "category"
  });

  if (!allCategories.length) return;

  const selected = new Set(); // Stores user-selected categories

  // 🔧 Create dropdown container and input field
  const dropdown = document.createElement("div");
  dropdown.className = "category-dropdown";

  const input = document.createElement("input");
  input.placeholder = "Search or create...";
  dropdown.appendChild(input);

  const optionsContainer = document.createElement("div");
  dropdown.appendChild(optionsContainer);

  const saveBtn = document.createElement("div");
  saveBtn.textContent = "✅ Add Selected";
  saveBtn.className = "category-option save-btn";
  saveBtn.style.fontWeight = "bold";
  saveBtn.style.textAlign = "center";
  saveBtn.style.borderTop = "1px solid #eee";
  saveBtn.style.marginTop = "6px";
  saveBtn.style.cursor = "pointer";
  dropdown.appendChild(saveBtn);

  // 🔁 Render category options into the container based on input
  function renderOptions(filter = "") {
    optionsContainer.innerHTML = "";

    const filtered = allCategories.filter(cat =>
      cat.toLowerCase().includes(filter.toLowerCase())
    );

    // Add each matching category option
    filtered.forEach(cat => {
      const option = createCategoryOption(cat, selected.has(cat), () => {
        if (selected.has(cat)) {
          selected.delete(cat);
          option.classList.remove("selected");
        } else {
          selected.add(cat);
          option.classList.add("selected");
        }
      });
      optionsContainer.appendChild(option);
    });

    // ➕ Create new category option if not found
    if (!allCategories.includes(filter) && filter.trim() !== "") {
      const createOption = createCategoryOption(`➕ Create "${filter}"`, false, () => {
        selected.add(filter);
        renderOptions(); // Rerender full list
      });
      optionsContainer.appendChild(createOption);
    }
  }

  // 🔍 Filter options on input
  input.addEventListener("input", () => renderOptions(input.value));
  renderOptions(); // Initial render with full list

  // ✅ On save: merge selected values and update Supabase
  saveBtn.onclick = async () => {
    const { data: current, error } = await supabase
      .from("item_types")
      .select("categories")
      .eq("id", itemId)
      .single();

    if (error || !current) return console.error("Failed to fetch current categories");

    const updated = Array.from(new Set([...(current.categories || []), ...selected]));

    await updateItemCategories(itemId, updated);
    dropdown.remove();
    activeDropdown = null;

    await refreshInventoryUI();
  };

  // 📌 Position dropdown and append to body
  document.body.appendChild(dropdown);
  positionDropdown(dropdown, anchorElement);
  activeDropdown = dropdown;

  // 🧼 Setup click-outside-to-close behavior
  setupClickOutsideToClose(dropdown, anchorElement, () => {
    activeDropdown = null;
  });
}

// 🔹 Controller: Populate category dropdown UI from dataset
// ✅ Replaces manual DOM creation with modular logic
// ✅ Splits concerns using helper utilities
// ✅ Automatically binds dropdown toggle behavior
function populateDropdowns({
  data,
  menuId,
  toggleId,
  column,
  optionClass = "dropdown-option",
  optionsContainerClass = "dropdown-options-container",
  searchId = "dropdown-search",
  placeholder = "Search...",
  onSelect = null,
  dataAttribute,
}) {
  // 🔸 Extract unique values from the specified column
  const options = extractUniqueFromArrayColumn(data, column);
  console.log("unique items", options);
  // 🔸 Render the dropdown with those options
  renderDropdownOptionsCustom({
    menuId,
    options,
    items: data,
    optionClass,
    optionsContainerClass,
    searchId,
    placeholder,
    onSelect,
    dataAttribute,
  });

  // 🔸 Setup toggle behavior
  setupDropdownToggle(toggleId, menuId);
}

// 🔹 Controller Function: Combines both helpers to populate category dropdown
// ✅ Used in the bulk-category select logic
// ✅ Extracts all unique categories from data and populates select with them
function populateCategoryDropdown(data) {
  const categories = extractUniqueFromColumn(data, "category");
  populateSelectOptions("bulk-category", categories, true);
}


/** 🔹 Toggle a favorite state for a specific item
 * ✅ Updates Supabase `favorites` table and local state
 * ✅ Triggers re-render
 */
async function toggleFavorite(itemId) {
  if (!currentUser) return;

  const isFav = userFavorites.has(itemId);
  const { error } = isFav
    ? await supabase.from("favorites").delete().eq("user_id", currentUser.id).eq("item_id", itemId)
    : await supabase.from("favorites").insert([{ user_id: currentUser.id, item_id: itemId }]);

  if (!error) {
    isFav ? userFavorites.delete(itemId) : userFavorites.add(itemId);
    const filtered = getFilteredItems(allItems);
    applySortAndRender(filtered);
  }
}

/**🔹 Toggle the selection state of a single item
 * ✅ Used for bulk editing UI
 */
function toggleSelectItem(itemId, checked) {
  checked ? selectedItems.add(itemId) : selectedItems.delete(itemId);
  updateBulkToolbar();
  const filtered = getFilteredItems(allItems);
  applySortAndRender(filtered);
}

/**  🔹 Updates the bulk action toolbar UI
 * ✅ Shows/hides toolbar depending on how many items are selected
 */
function updateBulkToolbar() {
  const toolbar = document.getElementById("bulk-toolbar");
  const count = document.getElementById("selected-count");
  const selectedCount = selectedItems.size;

  count.textContent = `${selectedCount} selected`;
  toolbar.classList.toggle("hidden", selectedCount === 0);
}


/**  🔹 Clears selectedItems and refreshes list + toolbar
 */
function clearSelectionAndRefresh() {
  selectedItems.clear();
  updateBulkToolbar();
  const filtered = getFilteredItems(allItems);
  applySortAndRender(filtered);
}


// =================== Bulk Favorite Toggle ===================== //
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

  clearSelectionAndRefresh();
  updateFilterChips(getActiveFilters());
  showToast(`⭐ Updated ${selectedItems.size} favorites`);
  hideLoading();
});


// =================== Bulk Category Assignment ===================== //
document.getElementById("bulk-category").addEventListener("change", async (e) => {
  let category = e.target.value;
  if (!category || selectedItems.size === 0) return;

  // ➕ Handle custom category entry
  if (category === "__new__") {
    const userInput = prompt("Enter a new category:");
    if (!userInput) return;
    category = userInput;

    // 🧠 Add new category option to dropdown (if not already present)
    const select = document.getElementById("bulk-category");
    const exists = [...select.options].some(opt => opt.value === category);

    if (!exists) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.insertBefore(option, select.lastElementChild);
      select.value = category; // Keep it selected
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

  // 🔁 Refresh full dataset + UI
  const { data, error } = await supabase.from("item_types").select("*");
  if (error) return console.error("Error refreshing items:", error);

  allItems = data;
  populateCategoryDropdown(data);
  clearSelectionAndRefresh();
  updateFilterChips(getActiveFilters());
  showToast(`📂 Moved ${selectedItems.size} items to “${category}”`);
  hideLoading();
});

//#endregion

//-------------------------------------------------------------------//




//--------------------------------------------------------


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

// ✅ Main entry point: Initializes app on DOM ready
// ✅ Applies modular functions, loads user data, sets up all UI handlers
document.addEventListener("DOMContentLoaded", async () => {
  // 🔹 Step 1: Authenticate and load user favorites
  currentUser = (await supabase.auth.getUser()).data.user;
  if (currentUser) {
    const { data: favs } = await supabase
      .from("favorites")
      .select("item_id")
      .eq("user_id", currentUser.id);
    userFavorites = new Set(favs.map(f => f.item_id));
  }

  // 🔹 Step 2: Fetch items from Supabase and store globally
  allItems = await fetchStockItems();
  populateDropdowns({ 
    data: allItems, //data from where categories will be extracted
    column: "categories", //the name of the column from where the categories will be extracted
    optionsContainerClass: "category-dropdown-container", //id of the div container where all the stuff will be
    toggleId: "category-dropdown-toggle", //id of the button that will make the menu pop up (html)
    menuId: "category-dropdown-menu", //id of the block that will show when toggle is in show (html)
    optionClass: "dropdown-option", //class that will be given to each of the dropdown buttons (injected)
    searchId: "category-search", //id of the search bar (injected by html)
    placeholder: "Search categories...", //text that will show up in the search bar
  });
  
// this is for the dropdown of the qr types
  populateDropdowns({
    data: allItems,
    column: "qr_type", // extract unique QR types
    optionsContainerClass: "qr-dropdown-container",
    toggleId: "qr-dropdown-toggle",
    menuId: "qr-dropdown-menu",
    optionClass: "dropdown-option",
    searchId: "qr-search",
    placeholder: "Search QR types...",
    dataAttribute: "qr"
  });
  //console.log("Fetched items:", allItems);
  //console.log("First item:", allItems[0]);

  
  // 🔹 Step 3: Apply filters from URL (syncs state)
  applyFiltersFromURL();

  // 🔹 Step 4: Render main view with filtering, sorting, chips
  //console.log("Raw filters:", extractFilterValues());
  const filtered = getFilteredItems(allItems);
  //console.log("Filtered items:", filtered);
  const filters = getActiveFilters();
  applySortAndRender(filtered);
  updateFilterChips(filters);


  // 🔹 Step 5: Populate and setup UI dropdowns
  // this is for the dropdown of the categories

  populateCategoryDropdown(allItems); //this funciton is going to be creating the dropdown for the bulk options
  setupDynamicFilters("filter-form", ["sort-select", "cards-per-page"]);;
  setupToggleBehavior("toggle-filters", "filter-section", "Hide Filters", "Show Filters");
  setupClearFilters("clear-filters", "filter-form");
  setupCustomDropdown({
    toggleId: "sortDropdownToggle",
    menuId: "sortDropdownMenu",
    containerSelector: ".custom-sort-dropdown",
    selectId: "sort-select"
  });

  // ✅ Bulk Toolbar Listeners
  document.getElementById("bulk-clear")?.addEventListener("click", () => {
    clearSelectionAndRefresh();
    showToast("✅ Cleared selection");
  });

  document.getElementById("bulk-delete")?.addEventListener("click", async () => {
    if (selectedItems.size === 0) return;
    showLoading();
    const idsToDelete = Array.from(selectedItems);

    const { error } = await supabase
      .from("item_types")
      .delete()
      .in("id", idsToDelete);

    if (!error) {
      allItems = await fetchStockItems();
      const updatedCount = selectedItems.size;
      clearSelectionAndRefresh();
      updateFilterChips(getActiveFilters());
      showToast(`🗑 Deleted ${updatedCount} items`);
    }
    hideLoading();
  });

  document.getElementById("bulk-favorite")?.addEventListener("click", async () => {
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
    const updatedCount = selectedItems.size;
    clearSelectionAndRefresh();
    updateFilterChips(getActiveFilters());
    showToast(`⭐ Updated ${updatedCount} favorites`);
    hideLoading();
  });

  document.getElementById("bulk-category")?.addEventListener("change", async (e) => {
    let category = e.target.value;
    if (!category || selectedItems.size === 0) return;

    if (category === "__new__") {
      const userInput = prompt("Enter a new category:");
      if (!userInput) return;
      category = userInput;

      const select = document.getElementById("bulk-category");
      const exists = [...select.options].some(opt => opt.value === category);
      if (!exists) {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = category;
        select.insertBefore(option, select.lastElementChild);
        select.value = category;
      }
    }

    showLoading();
    const updates = Array.from(selectedItems).map(id =>
      supabase.from("item_types").update({ category }).eq("id", id)
    );

    await Promise.all(updates);
    allItems = await fetchStockItems();
    populateCategoryDropdown(allItems);

    const updatedCount = selectedItems.size;
    clearSelectionAndRefresh();
    updateFilterChips(getActiveFilters());
    showToast(`📂 Moved ${updatedCount} items to “${category}”`);
    hideLoading();
  });

  // 🔹 Export Button for Selected Items
  document.getElementById("bulk-export")?.addEventListener("click", () => {
    const exportCards = Array.from(document.querySelectorAll(".stock-card"))
      .filter(card => selectedItems.has(card.dataset.itemId));
    if (exportCards.length === 0) return;
    exportCardsToCSV(exportCards);
  });
});


// 🔍 Live Search in Category Dropdown
function setupCategorySearch() {
  const searchInput = document.getElementById("category-search");
  const options = document.querySelectorAll("#category-dropdown-menu .dropdown-option");

  if (!searchInput) return;

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();

    options.forEach(option => {
      const text = option.textContent.toLowerCase();
      option.style.display = text.includes(query) ? "block" : "none";
    });
  });
}


/* to be able to upload functions to run them in the console
window.extractFilterValues = extractFilterValues;
window.getFilteredItems = getFilteredItems;
*/