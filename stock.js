// 🔹 Global App State
let currentPage = 1;                    // Current page number or pagination
let itemsPerPage = 6;                 // Number of items per page
let allItems = [];                     // Holds all fetched stock items
let userFavorites = new Set();         // Set of favorite item IDs for the current user
let currentUser = null;                // Holds authenticated user info
let currentEmployee = null;
let stockAccess = { role: "", isAdmin: false, canViewSensitive: false };
let selectedItems = new Set();         // Tracks currently selected items for bulk actions
let showOnlyFavorites = false;         // Flag to toggle "Show Only Favorites"
let activeDropdown = null;
let failedAttempts = 0;            // 🚫 Track how many wrong passwords
let lockoutUntil = null;           // ⏳ Timestamp until which delete is locked
// 🔒 In-memory cache for signed photo URLs
const signedUrlCache = new Map();
const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour
const STOCK_IMAGE_PROCESS_FUNCTION_NAME = "process-inventory-image";
const STOCK_PHOTO_BUCKET = "photos";
const STOCK_BACKGROUND_REMOVAL_MODULE_URL = "https://esm.sh/@imgly/background-removal@1.7.0?bundle";
const STOCK_LOCAL_UPLOAD_MAX_DIRECT_BYTES = 7 * 1024 * 1024;
const STOCK_LOCAL_UPLOAD_MAX_SIDE = 2200;
const STOCK_BACKGROUND_MAX_SOURCE_SIDE = 1600;
const STOCK_EDITOR_OUTPUT_SIZE = 1200;
const STOCK_CAPTURE_JOB_TABLE = "capture_jobs";
const STOCK_CAPTURE_PHOTO_TABLE = "capture_job_photos";
const STOCK_CAPTURE_STATION_TABLE = "capture_stations";
const STOCK_CAPTURE_POLL_INTERVAL_MS = 1500;
const STOCK_CAPTURE_POLL_TIMEOUT_MS = 120000;
const STOCK_CAPTURE_FALLBACK_LOOKBACK_MS = 15000;
let stockBackgroundRemovalModulePromise = null;
const STOCK_WORKER_ITEM_SELECT = [
  "id",
  "title",
  "description",
  "weight",
  "sale_price",
  "barcode",
  "qr_code",
  "photo_url",
  "created_at",
  "dymo_label_url",
  "photos",
  "qr_type",
  "categories",
  "stock",
  "stock_batch_size_update",
  "added_by",
  "added_by_email",
].join(", ");

const stockMediaState = {
  itemId: null,
  stagedImages: [],
  selectedPaths: new Set(),
  busy: false,
  latestCaptureJob: null,
  captureStations: [],
  selectedCaptureStationId: "",
  editor: {
    index: -1,
    image: null,
    imageElement: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
  },
};

const manualEbaySaleState = {
  item: null,
  stockRows: [],
  selectedStockRow: null,
  busy: false,
};

const TRAY_STATUS_LABELS = {
  checked_in: "Checked In",
  checked_out: "Checked Out",
  in_transfer: "In Transfer",
  weight_mismatch: "Weight Mismatch",
};

function buildStockLocationLabel(location, storeMap = {}) {
  if (!location) return "Unknown Location";
  const locationName = location.location_name || "Unknown Location";
  if (!location.is_tray) return locationName;

  const homeStore = storeMap[location.store_id] || "Unassigned";
  const currentStore = storeMap[location.tray_current_store_id] || homeStore;
  const status = TRAY_STATUS_LABELS[location.tray_status] || "Tray";
  return `${locationName} (Tray - ${status} - Current: ${currentStore} - Home: ${homeStore})`;
}

function escapeStockHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatStockMoney(value) {
  const number = Number(value || 0);
  return `$${number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function canViewSensitiveStockData() {
  return Boolean(stockAccess?.canViewSensitive);
}

function getStockItemSelectColumns() {
  return canViewSensitiveStockData() ? "*" : STOCK_WORKER_ITEM_SELECT;
}

function getStockCacheKey() {
  return canViewSensitiveStockData() ? "cachedAllItemsAdmin" : "cachedAllItemsWorker";
}

function applyStockAccessUi() {
  document.body.classList.remove("stock-access-loading");
  document.body.classList.toggle("worker-stock-view", !canViewSensitiveStockData());

  if (!canViewSensitiveStockData()) {
    const backButton = document.querySelector(".back-button");
    if (backButton) {
      backButton.setAttribute("href", "worker-dashboard.html");
    }
    document.querySelector('input[name="distributor"]')?.classList.add("hidden-sensitive-filter");
    document.querySelector('input[name="costMin"]')?.classList.add("hidden-sensitive-filter");
    document.querySelector('input[name="costMax"]')?.classList.add("hidden-sensitive-filter");
    document.querySelectorAll('#sortDropdownMenu [data-value^="cost"], #sort-select option[value^="cost"]').forEach((el) => el.remove());
    const sortSelect = document.getElementById("sort-select");
    if (sortSelect?.value?.startsWith("cost")) sortSelect.value = "title-asc";
  }
}

async function loadStockAccessForCurrentUser() {
  if (!currentUser?.id) return null;

  const { data, error } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.warn("Could not load stock employee access:", error);
    stockAccess = { role: "", isAdmin: false, canViewSensitive: false };
    window.stockAccess = stockAccess;
    applyStockAccessUi();
    return null;
  }

  currentEmployee = data || null;
  const role = String(data?.role || "").toLowerCase();
  stockAccess = {
    role,
    isAdmin: role === "admin",
    canViewSensitive: role === "admin",
  };
  window.stockAccess = stockAccess;
  applyStockAccessUi();
  return data;
}

function buildLocationChips(item) {
  const details = Array.isArray(item.stock_location_details) ? item.stock_location_details : [];
  if (!details.length) {
    return `<div class="stock-location-empty">No assigned locations</div>`;
  }

  return details.slice(0, 4).map((entry) => `
    <span class="stock-location-chip ${entry.is_tray ? "is-tray" : ""}">
      <strong>${escapeStockHtml(entry.location_name || "Unknown")}</strong>
      <small>${entry.is_tray ? `${escapeStockHtml(entry.tray_status_label || "Tray")} - ${escapeStockHtml(entry.current_store || "Unassigned")}` : escapeStockHtml(entry.store_name || "Fixed location")}</small>
      <b>${Number(entry.quantity || 0).toLocaleString()}</b>
    </span>
  `).join("") + (details.length > 4
    ? `<span class="stock-location-more">+${details.length - 4} more</span>`
    : "");
}



//---------------------------------------------------------------//
//#region function to render all the cards (renderstockitems) with its chips
  //#region getting the info of the card and the chips rendered
    //#region utilities necessary color chip in the card, remove them, add them
      
      // helped to get chip colors, returns a string saying the color class
      function getChipColor(label) {
        const hash = [...label].reduce((acc, char) => acc + char.charCodeAt(0), 0);/**
        * this is getting the label "Diamonds", then turning it into a hash
        gets each characted unicode, adds it up, and this will be your hash */
        const options = ["blue", "green", "purple", "gold", "gray"]; /**
        difines classes that are styled for different colors */
        return options[hash % options.length]; /** modulus function to consistently
        return a number between 0 and 4, and you can pick a color */
      } //will be used to render the stock card content
      
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
        await bumpInventoryVersion();

        // Refresh filtered + sorted UI
        await refreshItemById(itemId); // ✅ Only re-renders that card

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
        await refreshItemById(itemId); // ✅ Only re-renders that card

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

        await refreshItemById(itemId); // ✅ Only re-renders that card

      }

      // 🔧 Utility to update item categories from Supabase
      async function updateItemCategories(itemId, newCategories) {
        const { error } = await supabase
          .from("item_types")
          .update({ categories: newCategories })
          .eq("id", itemId);

        if (error) throw new Error(error.message);
      }

    //#endregion

    //Build the full card body with data-driven text content and chips
    function buildCardContent(item) {
      const stock = typeof item.stock === "number" ? item.stock : 0;
      const stockClass = stock === 0 ? "stock-zero" : "";
      const tooltip = item.stock_tooltip || "";
      const showSensitive = canViewSensitiveStockData();
      const descriptionText = String(item.description || "").trim() || "No description recorded.";
      const hasFullDescription = Boolean(String(item.description || "").trim());
      const stockLabel = `
        <button type="button" class="stock-count ${stockClass}" data-tooltip="${escapeStockHtml(tooltip)}" data-id="${item.id}">
          ${stock === 0 ? `<i data-lucide="alert-circle" class="stock-alert-icon"></i>` : ""}
          <span>In Stock</span>
          <strong>${Number(stock || 0).toLocaleString()}</strong>
        </button>
      `;

    
        const categoryChips = (item.categories || []).map(cat => { /**this
            specifies that if item.categories is undefinend, fall back to an 
            empty array []
            -map in this case will loop though each value of the array defined
            by caterogories in the item row */
            const color = getChipColor(cat); /**returns the color class */
            return `
                <div class="category-chip" data-color="${color}" data-cat="${escapeStockHtml(cat)}" data-id="${item.id}">
                ${escapeStockHtml(cat)}
                <button class="remove-category-btn" title="Remove categories">&times;</button>
                </div>
            `;
        }).join(""); /**glues all the string into one HTML block that will be in the
        javascrip object called category chips */
        
    
        return `
        <div class="stock-content">
          <div class="stock-card-headline">
            <h2>${escapeStockHtml(item.title || "Untitled item")}</h2>
            ${stockLabel}
          </div>
          <div class="stock-description-wrap">
            <p class="stock-description">${escapeStockHtml(descriptionText)}</p>
            ${hasFullDescription ? `<button type="button" class="stock-description-read-btn" data-id="${item.id}" aria-label="Read full description for ${escapeStockHtml(item.title || "this item")}">Read full description</button>` : ""}
          </div>
          <div class="stock-metric-grid">
            <span><small>Weight</small><strong>${Number(item.weight || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} g</strong></span>
            <span><small>Sale</small><strong>${formatStockMoney(item.sale_price)}</strong></span>
            <span><small>Barcode</small><button type="button" class="stock-barcode-btn" data-barcode="${escapeStockHtml(item.barcode || "")}">${escapeStockHtml(item.barcode || "-")}</button></span>
            ${showSensitive ? `<span><small>Cost</small><strong>${formatStockMoney(item.cost)}</strong></span>` : ""}
          </div>
          <div class="stock-location-section">
            <div class="stock-section-row">
              <span>Locations</span>
              <button type="button" class="transfer-stock-btn" data-id="${item.id}">Move Stock</button>
            </div>
            <div class="stock-location-chips">${buildLocationChips(item)}</div>
          </div>
          <details class="stock-card-details">
            <summary>More details</summary>
            ${showSensitive ? `<p><strong>Distributor:</strong> ${escapeStockHtml(item.distributor_name || "-")}<br/>${escapeStockHtml(item.distributor_phone || "")}</p>` : ""}
            ${showSensitive ? `<p><strong>Notes:</strong> ${escapeStockHtml(item.distributor_notes || "-")}</p>` : ""}
            <p><strong>QR Type:</strong> ${escapeStockHtml(item.qr_type || "-")}</p>
            <p><strong>Last Updated:</strong> ${escapeStockHtml(new Date(item.created_at).toLocaleString())}</p>
            ${item.dymo_label_url ? `<p><a href="#" class="dymo-link" data-path="${escapeStockHtml(item.dymo_label_url)}">DYMO Label</a></p>` : ""}
          </details>
          <div class="stock-sensitive-legacy">
          <p><strong>Weight:</strong> ${item.weight}</p>
          <p><strong>Cost:</strong> $${Number(item.cost || 0).toLocaleString()}</p>
          <p><strong>Sale Price:</strong> $${Number(item.sale_price || 0).toLocaleString()}</p>
          <p><strong>Distributor:</strong> ${item.distributor_name || "—"}<br/>${item.distributor_phone || ""}</p>
          <p><strong>Notes:</strong> ${item.distributor_notes || "—"}</p>
          <p><strong>QR Type:</strong> ${item.qr_type}</p>
          <p><strong>Barcode:</strong> ${item.barcode || "—"}</p>
          <p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>
          ${item.dymo_label_url ? `<p><a href="#" class="dymo-link" data-path="${item.dymo_label_url}">📄 DYMO Label</a></p>` : ""}
          </div>
          ${stockLabel}
          <p class="chip-section-label">Categories:</p>
          <div class="category-chips">
          ${categoryChips}
            <div id="cardchip-container-${item.id}" class="custom-dropdown" data-id="${item.id}">
              <button id="cardchip-toggle-${item.id}" type="button" class="dropdown-toggle" data-id="${item.id}" title="Add a category chip">
                <i data-lucide="plus" class="rotate-plus" id="cardchip-icon-${item.id}"></i>
            </button>
              <div id="cardchip-menu-${item.id}" class="dropdown-menu dropdown-menu--category"></div>
            </div>
          </div>
        </div>
        `; 
        //lucide.createIcons();
        /** the add-category-chip has a data-id so when the event listener is triggered
        it knows specifically to what it needs to add the category */
        /**it will resturn
         <div class="stock-content">
            <h2>Gold Ring</h2>
            <p>14K yellow gold with diamonds</p>
            <p><strong>Weight:</strong> 5</p>
            <p><strong>Cost:</strong> $200</p>
            ...
            <div class="category-chips">
                <div class="category-chip" data-color="gold" data-cat="Rings" data-id="abc123">
                Rings <button class="remove-category-btn">&times;</button>
                </div>
                <div class="add-category-chip" data-id="abc123">+ Add Category</div>
            </div>
        </div>
        */
    }
  //#endregion 

  //#region Build image carousel or fallback if no photos
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
    } //needs event listener
    
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
    } //needs event listener

    //carousel html block
    /**photos is going to be an array of photos URL 
    * Index is going to give you the position of the card in the main array
    * so you can see which carousel belongs to which item 
    */
    async function buildCarousel(item, index) {
      const paths = Array.isArray(item.photoPaths)
      ? item.photoPaths
      : Array.isArray(item.photos)
        ? item.photos
        : [];

      if (!paths.length) {
        return `<div class="no-photo">No Photos</div>`;
      }

      // Keep cards light: the full media set can still live in the editor,
      // but stock cards only need the primary photo for scanning and movement.
      const validPaths = paths.filter(p => typeof p === "string" && p.includes("/"));
      const visiblePaths = validPaths.slice(0, 1);

      const signedUrls = await Promise.all(
        visiblePaths.map(path => getSignedUrl(path))
      );

      const filteredOut = paths.filter(p => !(typeof p === "string" && p.includes("/")));
      if (filteredOut.length) {
        console.warn("⚠️ Skipping invalid paths:", filteredOut);
      }



      return `
        <div class="carousel" id="carousel-${index}">
          <div class="carousel-track">
            ${signedUrls.map((url, i) => `
              <img loading="lazy" src="${url}" class="carousel-photo stock-photo-open ${i === 0 ? 'active' : ''}" data-id="${item.id}" data-path="${escapeStockHtml(visiblePaths[i] || "")}" data-photo-index="${i}" alt="Item photo"/>
            `).join('')}
          </div>
          ${validPaths.length > 1 ? `<span class="stock-photo-count">+${validPaths.length - 1} photos</span>` : ""}
        </div>
      `;
    }


  //#endregion

  //getting the floating control for selection and favorited sections 
  /**id is the item id for the row
  * isSelected boolean
  * is favoried another boolean
  */
  function buildFloatControls(id, isSelected, isFavorited) {
    const checkbox = `
      <input type="checkbox" class="select-checkbox" data-id="${id}" ${isSelected ? "checked" : ""}>
    `;

    const favoriteBtn = currentUser
      ? `<button class="favorite-btn" data-id="${id}" title="Add to favorites">
          ${isFavorited ? '★' : '☆'}
        </button>`
      : '';

    const editBtn = `
      <button class="edit-item-btn" data-id="${id}" title="Edit this item">
        <svg xmlns="http://www.w3.org/2000/svg" class="lucide lucide-pencil-line" width="20" height="20" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
        </svg>
      </button>
    `;

    const photoBtn = `
      <button class="stock-add-photo-btn" data-id="${id}" title="Add item photos">
        <i data-lucide="camera"></i>
      </button>
    `;


    return `
      <div class="float-controls-inner">
        ${checkbox}
        ${favoriteBtn}
        ${photoBtn}
        ${editBtn} <!-- 🆕 placed edit button with existing float controls -->
      </div>
    `;
  }

  //function needed to coordinate html creation for one card
  /** item: individual inventory object with the full row of information
  * index: position of the item in the array
  */
  async function renderStockCard(item, index) {
    const card = document.createElement("div");
    card.className = "stock-card";
    card.style.position = "relative";
    card.dataset.itemId = item.id;

    const isFavorited = currentUser && userFavorites.has(item.id);
    const isSelected = selectedItems.has(item.id);
    if (isFavorited) card.classList.add("favorited");
    if (isSelected) card.classList.add("selected");

    const photoCarousel = await buildCarousel(item, index);
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


  //function needed to create the HTML all the stock cards available
  async function renderStockItems(data, containerIDToInjectCards = "stock-container") {
    const grid = document.getElementById(containerIDToInjectCards);
    grid.innerHTML = "";

    const fragment = document.createDocumentFragment();

    for (let index = 0; index < data.length; index++) {
      const item = data[index];
      const card = await renderStockCard(item, index);
      fragment.appendChild(card);
    }

    grid.appendChild(fragment);
    if (window.lucide) lucide.createIcons();
  }

  
  //#region Event listeners of this section
    /** Toggle a favorite state for a specific item
     * ✅ Updates Supabase `favorites` table and local state
     * ✅ Triggers re-render
     */
    async function toggleFavorite(itemId) {
      if (!currentUser) return;

      const isFav = userFavorites.has(itemId);
      const { error } = isFav
        ? await supabase.from("favorites").delete().eq("user_id", currentUser.id).eq("item_id", itemId)
        : await supabase.from("favorites").insert([{ user_id: currentUser.id, item_id: itemId }]);
        //await bumpInventoryVersion();
      if (!error) {
        isFav ? userFavorites.delete(itemId) : userFavorites.add(itemId);
        const filtered = getFilteredItems(allItems);
        applySortAndRender(filtered);
        
      }
    }

    /**🔧 Initializes all delegated DOM event listeners related to card UI interactions.
    * ✅ Should be called once after DOM is loaded or re-rendered (e.g., after filtering)
    * ✅ Uses event delegation to reduce per-element listeners
    */
    function setupCardEventListeners() {
      // 🎯 Handle all click-based interactions (e.g., favorite, category, carousel)
      document.addEventListener("click", (e) => {
        const actionTarget = e.target.closest("[data-id]");
        const id = actionTarget?.dataset.id || e.target.dataset.id; // Common data-id used for most card actions

        // ⭐ Toggle favorite status
        if (e.target.closest(".favorite-btn")) {
          toggleFavorite(id);
        }

        // ➕ Open dropdown to add category
        if (e.target.matches(".add-category-chip")) {
          showCategoryDropdown(id, e.target); // open dropdown attached to this card
        }

        // ❌ Remove a category chip from the card
        if (e.target.matches(".remove-category-btn")) {
          const chip = e.target.closest(".category-chip"); // get the full chip container
          const cat = chip?.dataset.cat;                   // which category?
          const itemId = chip?.dataset.id;                 // which item?
          if (cat && itemId) {
            removeCategory(itemId, cat);
                               // update data & UI
          }
          
        }

        // ⏪⏩ Carousel navigation: previous or next
        if (e.target.matches(".carousel-btn")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide(index) : nextSlide(index);      // go left or right
          }
        }

        // Open the full description without triggering card-level stock actions.
        const descriptionTrigger = e.target.closest(".stock-description-read-btn");
        if (descriptionTrigger) {
          e.preventDefault();
          e.stopPropagation();
          openStockDescriptionModal(descriptionTrigger.dataset.id);
          return;
        }

        const transferTrigger = e.target.closest(".stock-count, .transfer-stock-btn");
        if (transferTrigger) {
          const itemId = transferTrigger.dataset.id;
          if (itemId) {
            transferModule.openTransferModal(itemId);
          }
        }

        const photoTrigger = e.target.closest(".stock-photo-open");
        if (photoTrigger) {
          openStockPhotoViewer(photoTrigger.dataset.id, photoTrigger.dataset.path || "");
        }

        const addPhotoTrigger = e.target.closest(".stock-add-photo-btn");
        if (addPhotoTrigger) {
          openStockPhotoManager(addPhotoTrigger.dataset.id);
        }

        const barcodeTrigger = e.target.closest(".stock-barcode-btn");
        if (barcodeTrigger) {
          openBarcodeModal(barcodeTrigger.dataset.barcode || barcodeTrigger.textContent);
        }
      });

      // ☑️ Handle selection checkbox toggle (for bulk actions)
      document.addEventListener("change", (e) => {
        if (e.target.matches(".select-checkbox")) {
          const id = e.target.dataset.id;
          const checked = e.target.checked;

        //event listener for adding to virtual cart the selected cards
        if (checkoutModule.isCheckoutMode()) {
          const card = e.target.closest(".stock-card");
          if (card) {
            const isInCart = card.classList.contains("in-cart");
            const itemId = card.querySelector(".select-checkbox")?.dataset.id || 
                          card.querySelector(".favorite-btn")?.dataset.id || 
                          card.dataset.id;

            if (!itemId) return;

            if (isInCart) {
              checkoutModule.removeFromCart(itemId);
            } else {
              checkoutModule.handleCardClickForCheckout(card);
            }

            return;
          }
        }

          toggleSelectItem(id, checked); // update selectedItems Set + bulk toolbar
        }
      });

    }

  //#endregion 

//#endregion

//#region function of the filter, URL, and pagination system

  // Parse a string or value, return null if blank or invalid
  const parseOrNull = (val) => {
    const trimmed = typeof val === "string" ? val.trim() : val;
    return trimmed === "" || trimmed === null ? null : parseFloat(trimmed);
  };

  // Utility to format date into "YYYY-MM-DD" or return null
  const normalizeDate = (val) => {
    const parsed = new Date(val);
    return isNaN(parsed) ? null : parsed.toISOString().split("T")[0];
  };

  //#region engine to get the values in the filter form and filtering items
    //alias for the button function
    function getActiveFilters() {
      return extractFilterValues();
    }

    //Utility: Extract Filter Values from Form and UI
    // ✅ Used by both `getActiveFilters()` and `getFilteredItems()` to avoid duplication
    // ✅ Pulls values from form fields and selected categories
    function extractFilterValues() {
      syncHiddenInputsWithDropdowns()
      const form = document.getElementById("filter-form");
      const formData = new FormData(form);
      const showSensitive = canViewSensitiveStockData();

      return {
        title: formData.get("title")?.toLowerCase(),
        description: formData.get("description")?.toLowerCase(),
        barcode: formData.get("barcode")?.toLowerCase(),
        distributor: showSensitive ? formData.get("distributor")?.toLowerCase() : null,

        weightMin: parseOrNull(formData.get("weightMin")),
        weightMax: parseOrNull(formData.get("weightMax")),
        costMin: showSensitive ? parseOrNull(formData.get("costMin")) : null,
        costMax: showSensitive ? parseOrNull(formData.get("costMax")) : null,
        priceMin: parseOrNull(formData.get("priceMin")),
        priceMax: parseOrNull(formData.get("priceMax")),
        stockMin: parseOrNull(formData.get("stockMin")),
        stockMax: parseOrNull(formData.get("stockMax")),

        createdFrom: normalizeDate(formData.get("createdFrom")),
        createdTo: normalizeDate(formData.get("createdTo")),

        categories: [...new Set(
          [...document.querySelectorAll(".dropdown-option.selected[data-cat]")]
            .map(el => el.dataset.cat)
            .filter(Boolean)
        )],

        qr_type: [...document.querySelectorAll('.dropdown-option.selected[data-qr]')]
          .map(el => el.dataset.qr),

        location: [...new Set(
          [...document.querySelectorAll(".dropdown-option.selected[data-location]")]
            .map(el => el.dataset.location)
            .filter(Boolean)
        )],


      };
      /**this is a nutshell will return a key value object that then you can feed into other things
        {
          title: "gold",
          description: null,
          barcode: null,
          distributor: null,

          weightMin: 5,
          weightMax: 20,
          costMin: null,
          costMax: null,
          priceMin: 100,
          priceMax: 500,
          stockMin: null,
          stockMax: 50,

          createdFrom: Date('2024-01-01'),
          createdTo: null,

          categories: ["Rings", "Chains"],
          qr_type: ["QRT1", "QRT2"]
        }
      */
    } 

    //heart of the filter engine
    // ✅ Returns: a filtered array of items to be rendered in the grid
    // Applies all filters to a given list of items
    function getFilteredItems(items) {
      const filters = extractFilterValues();
      const matchAll = document.getElementById("match-all-toggle")?.classList.contains("active");

      return items.filter(item => {
        const matchesCategory = filters.categories.length === 0 ? true : 
          matchAll /**if no categories selected it returns true, is they are then it goes through matchall
          if the boolean is true then it must match every
          if the boolean is false then it must match at least 1 of the categories */
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
          (showOnlyFavorites ? userFavorites.has(item.id) : true) &&
          (filters.location.length === 0 || filters.location.some(loc => (item.stock_locations || []).includes(loc))) 

        );
      });
      /**in this case you will return an array of items that passed the filter conditions nothing else */
    }
  //#endregion
  
  //#region engine to sort items and render the final sorted results, and pagination controls
    //function to sort the items in the appropriate order
    function sortItems(data, sortValue) {
      // If no sort option is selected, return a shallow copy (unsorted)
      if (!sortValue) return [...data];
    
      // Parse the field to sort by and the direction (asc or desc)
      const [field, direction] = sortValue.split("-");
      const isAsc = direction === "asc";
      if (field === "cost" && !canViewSensitiveStockData()) return [...data];
    
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

    //adding button for the render pagination
    function addBtn(label, page, isActive, container) {
      const btn = document.createElement("button");
      btn.textContent = label;
      if (isActive) btn.classList.add("active");
      if (isActive && page === currentPage) btn.setAttribute("aria-current", "page");
      btn.addEventListener("click", () => {
        currentPage = page;
        const filtered = getFilteredItems(allItems);
        applySortAndRender(filtered);
        updateFilterChips(getActiveFilters()); //volver
        //updateURLFromForm(); //volver
      });
      container.appendChild(btn);
    }

    function getCompactPageList(totalPages) {
      if (totalPages <= 9) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
      }

      const pages = new Set([1, totalPages]);
      for (let page = currentPage - 2; page <= currentPage + 2; page += 1) {
        if (page >= 1 && page <= totalPages) pages.add(page);
      }

      const sorted = [...pages].sort((a, b) => a - b);
      return sorted.reduce((result, page, index) => {
        if (index > 0 && page - sorted[index - 1] > 1) result.push("...");
        result.push(page);
        return result;
      }, []);
    }

    //function to put buttons for the pages
    function renderPaginationControlsLegacy(totalPages) {
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

    function renderPaginationControls(totalPages) {
      const container = document.getElementById("pagination-buttons");
      container.innerHTML = "";

      if (totalPages <= 1) return;

      const compactBar = document.createElement("div");
      compactBar.className = "pagination-compact-bar";

      if (currentPage > 1) {
        addBtn("Prev", currentPage - 1, false, compactBar);
      }

      const summary = document.createElement("span");
      summary.className = "pagination-summary-pill";
      summary.textContent = `Page ${currentPage} of ${totalPages}`;
      compactBar.appendChild(summary);

      if (currentPage < totalPages) {
        addBtn("Next", currentPage + 1, false, compactBar);
      }

      const details = document.createElement("details");
      details.className = "pagination-page-drawer";
      const drawerSummary = document.createElement("summary");
      drawerSummary.textContent = "Pages";
      const pageList = document.createElement("div");
      pageList.className = "pagination-page-list";

      getCompactPageList(totalPages).forEach((page) => {
        if (page === "...") {
          const ellipsis = document.createElement("span");
          ellipsis.className = "pagination-ellipsis";
          ellipsis.textContent = "...";
          pageList.appendChild(ellipsis);
          return;
        }
        addBtn(page, page, page === currentPage, pageList);
      });

      details.appendChild(drawerSummary);
      details.appendChild(pageList);
      container.appendChild(compactBar);
      container.appendChild(details);
    }

    // paginate and renders the data you give it, here, the sorted items
    // ✅ Purpose: Paginates and renders a specific slice of data based on the current page
    // ✅ Accepts: 
    //    - `data`: full array of items to paginate (filtered and/or sorted)
    // ✅ Relies on global:
    //    - `currentPage`: which page user is on
    //    - `itemsPerPage`: how many items per page
    // ✅ Triggers:
    //    - `renderStockItems()`: shows the paginated items on screen
    //    - `renderPaginationControls()`: updates the pagination buttons
    async function paginateAndRender(data) {
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
      await renderStockItems(paginatedItems);

      // 🔁 Render the pagination controls (e.g. page buttons)
      renderPaginationControls(totalPages);
    }

    //after all the information is paginated you need to update the filter summary so
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

      const result = `<i data-lucide="search" class="icon lucide-inline"></i> Showing ${count} item${count !== 1 ? "s" : ""}${parts.length ? ` filtered by:` : ""}`;
      summaryEl.innerHTML = result;
      summaryEl.classList.add("active");
      if (window.lucide) lucide.createIcons();
    }

    //function coordinating the sorting of the data
    function applySortAndRender(data) {
      const sortValue = document.getElementById("sort-select")?.value;
      const sorted = sortItems(data, sortValue);
      paginateAndRender(sorted); //you update the chips are the end as well as the URL, be careful
      updateFilterSummary(sorted, getActiveFilters());
    }

  //#endregion

  //#region engine to be able to put filters in the URL, update them, get them
    //obtain the curret parameters from the URL
    function getURLParams() {
      return Object.fromEntries(new URLSearchParams(window.location.search)); /**first part of the function
      is retun object.fromentries is turning the object from URLSeachParam into a javascript object 
      window.location.search gives you the query string of the current URL (everything after the ?)
      stock.html?title=sasaas&sort=title-asc&limit=12&page=1 (in this case string after ?) 
      title=sasaas&sort=title-asc&limit=12&page=1
      URLSearchParams(...) turns that string into an object that acts like a Map
      getURLParams(); → { category: "Rings", page: "2" }
      */
    }

    //update the url with the current filters
    function updateURLFromForm() {
      syncHiddenInputsWithDropdowns()
      const form = document.getElementById("filter-form");
      const formData = new FormData(form); // 🔁 Get all input values

      // 🔸 Match-all checkbox for categories
      const matchAll = document.getElementById("match-all-toggle")?.checked;

      // 🔸 Prepare the query string
      const params = new URLSearchParams();

      // 🔁 Add each non-empty field from the form to the URL params
      for (const [key, value] of formData.entries()) {
        if (value) params.set(key, value);
      }

      // 🔸 Get selected categories from the dropdown UI
      const selectedCats = [...document.querySelectorAll(".dropdown-option.selected[data-cat]")]
      .map(el => el.dataset.cat);
      if (selectedCats.length > 0) {
        params.set("categories", selectedCats.join(","));
      }

      // 🔁 Add QR type filter (comma-separated string) if selected
        const selectedQRs = [...document.querySelectorAll(".dropdown-option.selected[data-qr]")]
        .map(el => el.dataset.qr);
        if (selectedQRs.length > 0) {
          params.set("qr_type", selectedQRs.join(","));
        }

      const selectedLocations = [...document.querySelectorAll(".dropdown-option.selected[data-location]")]
        .map(el => el.dataset.location);
      if (selectedLocations.length > 0) {
        params.set("location", selectedLocations.join(","));
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
      
    //application of the filters stored in theURL
    function applyFiltersFromURL() {
      const params = getURLParams();
      //console.log("🌐 URL Parameters on Load:", params);
      const form = document.getElementById("filter-form");

    
      // 🧹 Clear previous selection states to avoid duplicates
      document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el => {
        el.classList.remove("selected");
      });
      document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el => {
        el.classList.remove("selected");
      });
    
      // ✅ Now repopulate form inputs from URL
      for (const [key, value] of Object.entries(params)) {
        const input = form.querySelector(`[name="${key}"]`);
        if (input) input.value = value;
      }
    
      if (params.limit) {
        itemsPerPage = parseInt(params.limit);
        document.getElementById("cards-per-page").value = params.limit;
      }
    
      if (params.page) currentPage = parseInt(params.page);
    
      if (params.sort) {
        document.getElementById("sort-select").value = params.sort;
      }
    
      // 📂 Categories
      if (params.categories) {
        const catSet = new Set(params.categories.split(","));
        document.querySelectorAll(".dropdown-option[data-cat]").forEach(el => {
          if (!el.classList.contains("selected") && catSet.has(el.dataset.cat)) {
            el.classList.add("selected");
          }
        });
      }
      //syncHiddenInputsWithDropdowns();
      //const telli = document.getElementById("filter-form");
      //const formi = new FormData(telli);
      //const entries = Object.fromEntries(formi.entries());
      //console.log("🧾 Form Values for categories inside the apply filter from url:", formi.getAll("categories"))
      // 📂 QR Types
      if (params.qr_type) {
        const qrSet = new Set(params.qr_type.split(","));
        document.querySelectorAll(".dropdown-option[data-qr]").forEach(el => {
          if (qrSet.has(el.dataset.qr)) {
            el.classList.add("selected");
          }
        });
      }

      if (params.location) {
        const locSet = new Set(params.location.split(","));
        document.querySelectorAll(".dropdown-option[data-location]").forEach(el => {
          if (locSet.has(el.dataset.location)) {
            el.classList.add("selected");
          }
        });
      }

      if (params.matchAll === "true") {
        const matchToggle = document.getElementById("match-all-toggle");
        if (matchToggle) matchToggle.checked = true;
      }

      syncHiddenInputsWithDropdowns();
    }
    
  //#endregion

  /** function to set up event listeners for a select dropdown
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
      const isOpen = menu.classList.toggle("show");
      container.classList.toggle("active", isOpen);
      toggle.classList.toggle("open", isOpen); // 👉 This adds rotation class
    });
  
    // 🔁 Handle option selection
    menu.querySelectorAll("li").forEach((optionEl) => {
      optionEl.addEventListener("click", () => {
        const selectedValue = optionEl.getAttribute("data-value");
        const selectedLabel = optionEl.textContent;
  
        // ✏️ Update toggle button label
        toggle.innerHTML = `${selectedLabel} <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  
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
        toggle.classList.remove("open"); // 👉 Reset icon rotation
      });
    });
  
    // 🧼 Close if user clicks outside
    document.addEventListener("click", (e) => {
      if (!container.contains(e.target)) {
        menu.classList.remove("show");
        container.classList.remove("active");
        toggle.classList.remove("open"); // 👉 Reset icon rotation
      }
    });
  }
  

  /**function toset up live filtering, sorting, pagination, and favorites (event listeners and refreshing)
 * ✅ Attaches listeners to input elements in a filter form
 * ✅ When any input changes, it re-runs:
 *     - Filtering
 *     - Sorting
 *     - Pagination
 *     - Filter chip update
 *     - URL sync
 *
 * @param {string} formId - ID of the filter form (e.g. "filter-form")
 * @param {string[]} additionalIds - Extra input IDs outside the form (e.g. sort dropdown, page size)
 */
  function setupDynamicFilters(formId, additionalIds = []) {
    // 📌 Get the form element by ID
    const form = document.getElementById(formId);
    if (!form) return; // 🛑 Exit early if the form doesn't exist

    /**
     * 🧠 Central handler that runs every time any filter input changes
     * It updates:
     * - The filtered list
     * - The sort order
     * - The rendered cards
     * - The filter chips
     * - The URL query string
     */
    const handleFilterChange = () => {
      currentPage = 1; // ⏮ Always reset pagination to page 1

      const filtered = getFilteredItems(allItems); // 🧠 Apply all active filters
      const filters = getActiveFilters();          // 🎯 Get the latest filters for chips & URL

      applySortAndRender(filtered); // 📦 Sort, paginate, and display the filtered list
      updateFilterChips(filters);   // 💬 Update the visual summary of active filters (chips)
      updateURLFromForm();          // 🔗 Sync the filter state to the browser URL
    };

    // 🔁 Attach event listeners to all <input> and <select> elements inside the form
    const inputs = form.querySelectorAll("input, select");
    inputs.forEach(input => {
      input.addEventListener("input", handleFilterChange); // 👂 Live re-filtering on any input change
    });

    // 🔁 Also attach listeners to external filter-related inputs by ID
    additionalIds.forEach(id => {
      const el = document.getElementById(id); // 🎯 Try to find the element
      if (!el) return;                        // 🚫 Skip if not found

      el.addEventListener("change", (e) => {
        if (id === "cards-per-page") {
          itemsPerPage = parseInt(e.target.value); // 🔢 Update how many items to show per page
        } else if (id === "sort-select") {
          currentPage = 1;                         // 🔁 Reset page on sort change
        }
        handleFilterChange();                      // 🔄 Re-run filtering and rendering logic
      });
    });

    // ⭐ Attach listener for "Favorites Only" toggle if it exists
    const favToggle = document.getElementById("show-favorites-only");
    if (favToggle) {
      favToggle.addEventListener("change", (e) => {
        showOnlyFavorites = e.target.checked; // ✅ Enable or disable favorites-only filtering
        handleFilterChange();                 // 🔄 Re-render filtered results accordingly
      });
    }
  }

  /**function to set up event listenes to the tabs to switch filter sections, and the match-All toggle
   * Includes:
   * - Tab switching between filter sections
   * - Match-All toggle logic
   */
  function setupFilterPanelUI() {
    // 🔘 Tab button switching (e.g., Basic / Range / Labels)
    const tabButtons = document.querySelectorAll('.filter-tab-btn');
    const tabContents = document.querySelectorAll('.filter-tab-content');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const targetTab = button.getAttribute('data-tab');

        // 🔄 Deselect all tab buttons
        tabButtons.forEach(btn => btn.classList.remove('active'));

        // 🔄 Hide all tab contents
        tabContents.forEach(content => content.classList.remove('active'));

        // ✅ Highlight the clicked button
        button.classList.add('active');

        // ✅ Show the matching tab panel
        const contentToShow = document.getElementById(`tab-${targetTab}`);
        if (contentToShow) contentToShow.classList.add('active');
      });
    });

    // ☑️ Match-All toggle for category logic (AND vs OR)
    const matchAllToggleBtn = document.getElementById("match-all-toggle");
    if (matchAllToggleBtn) {
      matchAllToggleBtn.addEventListener("click", () => {
        const isActive = matchAllToggleBtn.classList.toggle("active");

        // Update label text and data attribute
        matchAllToggleBtn.textContent = `Match All Categories: ${isActive ? "On" : "Off"}`;
        matchAllToggleBtn.dataset.matchAll = isActive;

        // Refilter items with new logic
        currentPage = 1;
        const filtered = getFilteredItems(allItems);
        applySortAndRender(filtered);
        updateFilterChips(getActiveFilters());
        updateURLFromForm();
      });
    }

    //select all logic
    const selectAllBtn = document.getElementById("select-all-visible");
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => {
        const filtered = getFilteredItems(allItems); // ✅ all items matching filters
        const visibleIds = new Set(filtered.map(item => item.id));

        const allSelected = filtered.every(item => selectedItems.has(item.id));

        if (allSelected) {
          // ❌ Deselect all filtered
          filtered.forEach(item => {
            selectedItems.delete(item.id);
          });
          // Optional: update only visible DOM cards
          document.querySelectorAll(".stock-card").forEach(card => {
            const id = card.dataset.itemId;
            if (visibleIds.has(id)) {
              card.classList.remove("selected");
              const checkbox = card.querySelector(".select-checkbox");
              if (checkbox) checkbox.checked = false;
            }
          });
          selectAllBtn.innerHTML = `<i data-lucide="check-square" class="icon"></i> Select All Visible`;
        } else {
          // ✅ Select all filtered
          filtered.forEach(item => {
            selectedItems.add(item.id);
          });
          // Optional: update only visible DOM cards
          document.querySelectorAll(".stock-card").forEach(card => {
            const id = card.dataset.itemId;
            if (visibleIds.has(id)) {
              card.classList.add("selected");
              const checkbox = card.querySelector(".select-checkbox");
              if (checkbox) checkbox.checked = true;
            }
          });
          selectAllBtn.innerHTML = `<i data-lucide="square" class="icon"></i> Deselect All`;
        }

        if (window.lucide) lucide.createIcons();
        updateBulkToolbar();
      });
    }



  }

  // 🔧 function to clear filter from filter form button plus its logic
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

//#endregion

//#region chip creating system for unified panel, no for cards
  //creates the chip that will be displayed in the main console
  function createFilterChip(label, key) {
    const chip = document.createElement("div");
    chip.className = "filter-chip";
  
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
  
    const closeBtn = document.createElement("button");
    closeBtn.setAttribute("data-key", key);
    closeBtn.innerHTML = "&times;";
    closeBtn.className = "chip-close-btn";
  
    closeBtn.addEventListener("click", () => {
      chip.classList.add("removing");
  
      setTimeout(() => {
        if (key === "categories") {
          const valueToRemove = label.split(": ")[1];
          document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el => {
            if (el.dataset.cat === valueToRemove) {
              el.classList.remove("selected");
              console.log("📋I went inside");
              syncHiddenInputsWithDropdowns()
            }
          });
      
          console.log("📋 Remaining selected categories after removal:");
          document.querySelectorAll(".dropdown-option[data-cat]").forEach(el => {
            if (el.classList.contains("selected")) {
              console.log("✅", el.dataset.cat, el);
            }
          });
      
        } else if (key === "qr_type") {
          document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el => {
            if (el.dataset.qr === label.split(": ")[1]) {
              el.classList.remove("selected");
            }
          });
        } else if (key === "location") {
  const valueToRemove = label.split(": ")[1];
  document.querySelectorAll(".dropdown-option.selected[data-location]").forEach(el => {
    if (el.dataset.location === valueToRemove) {
      el.classList.remove("selected");
    }
  });

        } else {
          const input = document.querySelector(`[name="${key}"]`);
          if (input) input.value = "";
        }
        syncHiddenInputsWithDropdowns()
        currentPage = 1;
        const filtered = getFilteredItems(allItems);
        applySortAndRender(filtered);
        updateFilterChips(getActiveFilters());
        
        // ✅ Ensure the URL is updated when any chip is dismissed
        //const form = document.getElementById("filter-form");
        //const formData = new FormData(form);
        //const entries = Object.fromEntries(formData.entries());
        //console.log("🧾 Form Values After chip is removed:", formData.getAll("categories"))
        updateURLFromForm();
      }, 200);
      
    });
  
    chip.appendChild(labelSpan);
    chip.appendChild(closeBtn);
    return chip;
  }

  /**extract the information from the filters, transforms it to key and value
  and uses top function to create HTML to then append it to node */
  /**
  * Updates the filter chip display panel based on the current active filters.
  * It creates visual "chips" for each active filter field, allowing users to
  * remove filters by clicking the ❌ button on each chip.
  *
  * @param {Object} filters - The object representing all active filters
  */
  function updateFilterChips(filters) {
    // 🔍 Locate the container element where chips will be displayed
    const chipContainer = document.getElementById("header-filter-chips");
    if (!chipContainer) return;

    // 🧹 Clear out all previously rendered chips to avoid residual duplicates
    chipContainer.innerHTML = "";

    // 🧱 Go through each key-value pair in the filters object
    for (const [key, value] of Object.entries(filters)) {
      // 🚫 Skip null, empty string, or empty arrays
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;

      // 🏷️ Label that will be rendered as chip text (set below)
      let label = "";

      // 🧠 Handle special cases like arrays (categories, QR types)
      switch (key) {
        // ✅ For category filters (multi-value array)
        case "categories":
          if (Array.isArray(value)) {
            // 🧯 Deduplication guard: avoid rendering the same chip twice
            const existingLabels = new Set();

            value.forEach(cat => {
              const chipLabel = `Category: ${cat}`;
              if (!existingLabels.has(chipLabel)) {
                chipContainer.appendChild(createFilterChip(chipLabel, "categories"));
                existingLabels.add(chipLabel);
              }
            });
          }
          continue; // skip the rest of loop for this key

        // ✅ For QR type filters (also array)
        case "qr_type":
          if (Array.isArray(value)) {
            value.forEach(qr => {
              chipContainer.appendChild(createFilterChip(`QR: ${qr}`, "qr_type"));
            });
          }
          continue; // skip the rest of loop for this key

        // ✅ For location filters (also array)
        case "location":
          if (Array.isArray(value)) {
            value.forEach(loc => {
              chipContainer.appendChild(createFilterChip(`Location: ${loc}`, "location"));
            });
          }
          continue; // skip the rest of loop for this key

        // ✅ Handle all other known keys with a single-value label
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

        // 🛑 Skip unknown or unhandled keys
        default:
          continue;
      }

      // 🧱 Create and add the chip for the current label to the container
      chipContainer.appendChild(createFilterChip(label, key));
    }
  }

//#endregion

//#region function render bulk toolbar after event listener capure change in select-box
  //function to get the user geographical location 
  function getUserLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        return reject("Geolocation is not supported.");
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };
          resolve(coords);
        },
        (err) => {
          reject(`Failed to get location: ${err.message}`);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    });
  }

  //function to validate password before deleting items
  async function validatePassword(password) {
    if (!currentUser || !password) return false;
  
    const { data, error } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password,
    });
  
    return !error; // ✅ valid if no error
  }
  
  //function to count how many items have been selected
  function updateBulkToolbar() {
    const toolbar = document.getElementById("bulk-toolbar");
    const count = document.getElementById("selected-count");
    const selectedCount = selectedItems.size;

    count.textContent = `${selectedCount} selected`;
    toolbar.classList.toggle("show", selectedCount > 0);
    toolbar.classList.toggle("hide", selectedCount === 0);
  } 

  //function activated upon selecting checkbox
  function toggleSelectItem(itemId, checked) {
      checked ? selectedItems.add(itemId) : selectedItems.delete(itemId); /**
      if the bookean checked is true it adds the item to the global, otherwise it
      deletes it from the list */

      const card = document.querySelector(`.stock-card[data-item-id="${itemId}"]`);
      if (card) {
        card.classList.toggle("selected", checked); // adds or removes 'selected' class
      }
     
      updateBulkToolbar(); /** this function will tell the system to show
      or to hided the div with the bulk-toolbar id, and to update the selected
      count div that will show ho many items have been chosen */

      //const filtered = getFilteredItems(allItems);
      //applySortAndRender(filtered);
  }

  /** Clears selectedItems for toolbar and refreshes list + toolbar*/
  function clearSelectionAndRefresh() {
    selectedItems.clear();
    updateBulkToolbar();
    const filtered = getFilteredItems(allItems);
    applySortAndRender(filtered);

    // ✅ Reset the Select All Visible toggle label
    const selectAllBtn = document.getElementById("select-all-visible");
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => {
        const filtered = getFilteredItems(allItems); // this is your current logic
        let allSelected = filtered.every(item => selectedItems.has(item.id));

        if (allSelected) {
          // ❌ Deselect all filtered
          filtered.forEach(item => {
            selectedItems.delete(item.id);
            const card = document.querySelector(`.stock-card[data-item-id="${item.id}"]`);
            if (card) {
              const checkbox = card.querySelector(".select-checkbox");
              if (checkbox) checkbox.checked = false;
              card.classList.remove("selected");
            }
          });
          selectAllBtn.innerHTML = `<i data-lucide="check-square" class="icon"></i> Select All Visible`;
        } else {
          // ✅ Select all filtered
          filtered.forEach(item => {
            selectedItems.add(item.id);
            const card = document.querySelector(`.stock-card[data-item-id="${item.id}"]`);
            if (card) {
              const checkbox = card.querySelector(".select-checkbox");
              if (checkbox) checkbox.checked = true;
              card.classList.add("selected");
            }
          });
          selectAllBtn.innerHTML = `<i data-lucide="square" class="icon"></i> Deselect All`;
        }

        if (window.lucide) lucide.createIcons();
        updateBulkToolbar();
      });
    }

  }

  /** 🧰 Sets up event listeners for all bulk toolbar actions, except dropwdown of of course
  * - Clear selection
  * - Delete selected items
  * - Toggle favorite status
  * - Export selected items to CSV
  */
  function setupBulkToolbarListeners() {
    // 🚫 Clear all selected items
    document.getElementById("bulk-clear")?.addEventListener("click", () => {
      clearSelectionAndRefresh();         // Deselect all and re-render
      showToast("✅ Cleared selection");  // Show toast notification
    });

    // 🗑 Delete selected items from Supabase
    // 🔴 Event listener for the "Delete" button in the bulk toolbar
    // ✅ Bulk Delete: Show password confirmation before deletion
    document.getElementById("bulk-delete")?.addEventListener("click", async () => {
      if (!canViewSensitiveStockData()) {
        showToast("Only admins can delete stock items.");
        return;
      }
      if (selectedItems.size === 0) return;
    
      const now = Date.now();
      const modal = document.getElementById("password-confirm-modal");
      const input = document.getElementById("password-input");
      const confirmBtn = document.getElementById("confirm-password-btn");
      const cancelBtn = document.getElementById("cancel-password-btn");
      const errorMsg = document.getElementById("password-error");
      const lockoutMsg = document.getElementById("lockout-message");
      const body = document.body;
    
      // 🛑 If in lockout period, show countdown
      if (lockoutUntil && now < lockoutUntil) {
        const secondsLeft = Math.ceil((lockoutUntil - now) / 1000);
        lockoutMsg.textContent = `⏳ Locked out. Try again in ${secondsLeft}s`;
        lockoutMsg.classList.add("show");
        errorMsg.classList.remove("show");
    
        modal.classList.add("show");
        modal.classList.remove("hidden");
        body.classList.add("modal-open");
    
        setTimeout(() => {
          modal.classList.remove("show");
          modal.classList.add("hidden");
          body.classList.remove("modal-open");
        }, 2000);
        return;
      }
    
      // Reset modal state and open
      input.value = "";
      errorMsg.classList.remove("show");
      lockoutMsg.classList.remove("show");
      modal.classList.add("show");
      modal.classList.remove("hidden");
      body.classList.add("modal-open");
      input.focus();
    
      // Cancel logic
      cancelBtn.onclick = () => {
        modal.classList.remove("show");
        modal.classList.add("hidden");
        body.classList.remove("modal-open");
      };
    
      // Confirm logic
      confirmBtn.onclick = async () => {
        const password = input.value.trim();
        if (!password) return;
    
        const isValid = await validatePassword(password);
    
        if (!isValid) {
          failedAttempts += 1;
    
          if (failedAttempts >= 3) {
            lockoutUntil = Date.now() + 30000;
            errorMsg.classList.remove("show");
            lockoutMsg.textContent = `⛔ Too many attempts. Locked for 30s.`;
            lockoutMsg.classList.add("show");
    
            setTimeout(() => {
              modal.classList.remove("show");
              modal.classList.add("hidden");
              body.classList.remove("modal-open");
            }, 2000);
            return;
          }
    
          errorMsg.textContent = "❌ Incorrect password.";
          errorMsg.classList.add("show");
          return;
        }
    
        let location;
        try {
          location = await getUserLocation();
        } catch (e) {
          errorMsg.textContent = "🌐 Unable to get location. Deletion blocked.";
          errorMsg.classList.add("show");
          return;
        }
    
        // Proceed
        failedAttempts = 0;
        lockoutUntil = null;
        modal.classList.remove("show");
        modal.classList.add("hidden");
        body.classList.remove("modal-open");
        showLoading();
    
        const idsToDelete = Array.from(selectedItems);
        const itemsToLog = allItems.filter(item => idsToDelete.includes(item.id));
    
        const { error } = await supabase
          .from("item_types")
          .delete()
          .in("id", idsToDelete);
    
        if (!error) {
          await supabase.from("deletion_log").insert({
            user_id: currentUser.id,
            deleted_ids: idsToDelete,
            deleted_data: itemsToLog,
            timestamp: new Date().toISOString(),
            location_lat: location.lat,
            location_lng: location.lng
          });

          await bumpInventoryVersion();
          await loadAllItemsWithCache();
          const updatedCount = selectedItems.size;
          clearSelectionAndRefresh();
          updateFilterChips(getActiveFilters());
          showToast(`🗑 Deleted ${updatedCount} items`);
        }
    
        hideLoading();
      };
    
      input.onkeydown = (e) => {
        if (e.key === "Enter") confirmBtn.click();
      };
    });
    
    
    
    // ⭐ Add or remove favorites in bulk
    document.getElementById("bulk-favorite")?.addEventListener("click", async () => {
      if (!currentUser || selectedItems.size === 0) return;

      showLoading();

      const updates = [];

      for (const id of selectedItems) {
        const isFav = userFavorites.has(id);

        if (isFav) {
          // 🧹 Remove from favorites
          updates.push(
            supabase.from("favorites").delete().eq("item_id", id).eq("user_id", currentUser.id)
            
          );
          userFavorites.delete(id);
        } else {
          // ➕ Add to favorites
          updates.push(
            supabase.from("favorites").insert({ item_id: id, user_id: currentUser.id })
          );
          userFavorites.add(id);
        }
      }

      await Promise.all(updates); // Run all Supabase operations in parallel

      const updatedCount = selectedItems.size;
      clearSelectionAndRefresh();
      updateFilterChips(getActiveFilters());
      showToast(`⭐ Updated ${updatedCount} favorites`);
      hideLoading();
      await bumpInventoryVersion();
    });

    // 📄 Export selected cards to CSV
    document.getElementById("bulk-export")?.addEventListener("click", () => {
      if (!canViewSensitiveStockData()) {
        showToast("Only admins can export stock data.");
        return;
      }
      const exportCards = Array.from(document.querySelectorAll(".stock-card"))
        .filter(card => selectedItems.has(card.dataset.itemId));

      if (exportCards.length === 0) return;

      //exportCardsToCSV(exportCards); // Export utility function
    });
  }

  /**event listerner for the modal button */
  const closePasswordModalBtn = document.getElementById("close-password-modal");
  if (closePasswordModalBtn) {
    closePasswordModalBtn.addEventListener("click", () => {
      document.getElementById("password-confirm-modal")?.classList.remove("show");
      document.body.classList.remove("modal-open");
    });
  }


//#endregion

//#region function to generate a full dropwdown menu with search bar for normal and bulk operation
  // 🔧 Custom dropdown toggle for per-card category injection
  function setupCardChipDropdownDelegated() {
    // 🧩 Event delegation: handle any click on the page
    document.addEventListener("click", async (e) => {
      // 🔍 Check if the clicked element is a "+ Add Category" toggle button
      const isToggle = e.target.id?.startsWith("cardchip-toggle-");
      if (!isToggle) return; // 🚫 Ignore clicks that aren't on toggle buttons
  
      // 🆔 Extract item ID from the toggle's ID (e.g., "cardchip-toggle-abc123" -> "abc123")
      const button = e.target;
      const itemId = button.id.replace("cardchip-toggle-", "");
  
      // 🎯 Find the matching dropdown menu element for that item
      const menu = document.getElementById(`cardchip-menu-${itemId}`);
      if (!menu) return; // 🛑 Exit if no matching menu found
  
      // 🧹 Close any other open dropdowns before opening this one
      if (activeDropdown && activeDropdown !== menu) {
        activeDropdown.classList.remove("show");
      }
  
      // 🧠 Only render the dropdown content if it's not already populated
      if (!menu.dataset.populated) {
        // 📦 Get unique category values from the dataset
        const options = extractUniqueFromArrayColumn(allItems, "categories");
  
        // 🔎 Set a unique ID for the search input (helps prevent conflicts)
        const searchId = `cardchip-search-${itemId}`;
  
        // 🧱 Inject search bar + options into the dropdown container
        renderDropdownOptionsCustom({
          menuId: menu.id,                          // ID of the dropdown container
          options,                                  // Array of category options to render
          searchId,                                 // ID of the search input field
          placeholder: "Search categories...",      // Placeholder text for the input
          optionClass: "dropdown-option",           // Class given to each option item
          dataAttribute: "cardchip",                // Custom data-* tag for card categories
          optionsContainerClass: "dropdown-options-chip", // Wraps option list
          onClick: (value, isNew, optionEl) => {    // 🖱️ When an option is clicked
            onClickCardChipCategory(value, isNew, optionEl); // Add it to the item
            refreshUIAfterCategoryChange();               // Refresh the UI after update
          }
        });
  
        // ✅ Flag this dropdown as "already populated" to avoid future re-renders
        menu.dataset.populated = "true";
      }
  
      // 👁️ Toggle the visibility of this dropdown
      menu.classList.toggle("show");
      // 🌀 Rotate the + icon
      const icon = button.querySelector(".rotate-plus");
      if (icon) icon.classList.toggle("rotated");

  
      // 📌 Track the currently open dropdown globally
      activeDropdown = menu.classList.contains("show") ? menu : null;
    });
  
    // 🧼 Global listener: close any open dropdown if user clicks outside it
    document.addEventListener("click", (e) => {
      if (
        activeDropdown &&                                // There’s a menu open
        !e.target.closest(".custom-dropdown") &&         // User clicked outside dropdown wrapper
        !e.target.classList.contains("dropdown-option")  // and not on an option
      ) {
         // 🔄 Remove the rotated class from the icon
        const wrapper = activeDropdown.closest(".custom-dropdown");
        const icon = wrapper?.querySelector(".rotate-plus");
        if (icon) icon.classList.remove("rotated");

        activeDropdown.classList.remove("show");         // ❌ Hide dropdown
        activeDropdown = null;                           // 🔁 Reset global pointer
      }
    });
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

  //refreshed after changes are made 
  function refreshUIAfterCategoryChange() {
    const filtered = getFilteredItems(allItems);
    applySortAndRender(filtered);
    updateBulkToolbar() 
    populateDropdowns({
      data: allItems,                   // your full dataset
      menuId: "bulk-category-menu",          // ID of the dropdown container
      toggleId: "bulk-category-toggle",      // ID of the toggle button (if applicable)
      optionsContainerClass: "bulk-category-container",
      column: "categories",             // column to extract unique values from
      dataAttribute: "cat", 
      optionClass: "dropdown-option",
      searchId: "category-search", //id of the search bar (injected by html)
      placeholder: "Search categories...", //text that will show up in the search bar          
      onClick: (value, isNew) => {
        addValueToSelectedItems({
          table: "item_types",
          column: "categories",
          value,
          selectedIds: selectedItems,
          allItems
        }).then(() => {
          refreshUIAfterCategoryChange(); // update DOM + dropdown
        });
      }
    });
  }

  //function to transform the inputs into selected so it can be read by the form 
  function syncHiddenInputsWithDropdowns() {
    const form = document.getElementById("filter-form");
    //const telecooll = new FormData(form);
    //console.log("🧾 Form Values from inside synchhindder:", telecooll.getAll("categories"))

    // 🔍 Log current state before clearing
    //console.log("🧹 Before clearing: categories =", [...form.querySelectorAll('input[name="categories"]')].map(i => i.value));
  
    // 🔁 Clear previous category inputs
    form.querySelectorAll('input[name="categories"]').forEach(el => el.remove());
    form.querySelectorAll('input[name="qr_type"]').forEach(el => el.remove());

    //let catInputCounter = 0;
  
    // ✅ Add back categories from selected dropdowns
    document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el => {
      //catInputCounter++;
      //console.log(`📌 Hidden category input #${catInputCounter}: ${el.dataset.cat}`);
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "categories";
      input.value = el.dataset.cat;
      form.appendChild(input);
    });
    //catInputCounter = 0;
    // ✅ Add back QR types from selected dropdowns
    document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "qr_type";
      input.value = el.dataset.qr;
      form.appendChild(input);
    });

    // Clear and re-add location filters
    form.querySelectorAll('input[name="location"]').forEach(el => el.remove());

    document.querySelectorAll(".dropdown-option.selected[data-location]").forEach(el => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "location";
      input.value = el.dataset.location;
      form.appendChild(input);
    });

  
    // ✅ Log final result
    //console.log("✅ After sync: categories =", [...form.querySelectorAll('input[name="categories"]')].map(i => i.value));
  }
  
  //function to just set dropdown-option as selected
  const setAsSelected = (value, isNew, el) => {
    if (!el) return;
    el.classList.toggle("selected");
    currentPage = 1;
    const filtered = getFilteredItems(allItems);
    applySortAndRender(filtered);
    updateFilterChips(getActiveFilters());
    updateURLFromForm();
  };

  //deployed function on add category inside the chip 
  /**
  * 🔘 onClick handler for card-level "Add Category" dropdown
  * ✅ Handles both existing and new categories
  * ✅ Reads the specific item ID from the dropdown container
  * ✅ Applies the selected category to that item via Supabase
  *
  * @param {string} value - The selected or newly created category value
  * @param {boolean} isNew - Whether this is a brand-new category (true) or existing (false)
  * @param {HTMLElement} optionEl - The clicked DOM element inside the dropdown
  */
  function onClickCardChipCategory(value, isNew, optionEl) {
    // 🔍 Get the ID from the clicked element’s ancestors
    const container = optionEl.closest(".custom-dropdown");
  
    // 🆔 Extract the item ID from the container's ID (e.g., "cardchip-container-abc123")
    const idAttr = container?.id || "";
    const itemId = idAttr.startsWith("cardchip-container-") ? idAttr.replace("cardchip-container-", "") : null;
  
    // 🛑 Exit if ID is missing or value is invalid
    if (!itemId || !value) return;
  
    // ✅ Apply the selected category to that specific item
    applyCategory(itemId, value);
  }
  
  //deployed function on select for bulk operations
  /**
   * Adds a value (e.g. category/tag/type) to a specific column of all selected items in a table,
   * only if the value is not already present in that item's array field.
   * Executes all updates in parallel using Promise.all for efficiency.
   *
   * @param {Object} config
   * @param {string} config.table - Supabase table name (e.g. "item_types")
   * @param {string} config.column - Column name to update (must be an array-type column)
   * @param {string} config.value - The value to add (e.g. a category name)
   * @param {Array<string>} config.selectedIds - Array or Set of item IDs to update
   * @param {string} [config.matchColumn="id"] - Column used to match items (default is "id")
   * @param {Array<Object>} config.allItems - Local reference to the full dataset for syncing
   */
  async function addValueToSelectedItems({
    table,
    column,
    value,
    selectedIds,
    allItems,
    matchColumn = "id"
  }) {
    const updates = []; // Array of promises for parallel Supabase updates

    // 🔁 Loop through each selected ID (can be a Set or Array)
    for (const itemId of selectedIds) {
      // 🔍 Find the corresponding item in your local allItems array
      const item = allItems.find(i => i[matchColumn] === itemId);
      if (!item) continue; // Skip if not found

      // ✅ Ensure the target column is an array
      const currentValues = Array.isArray(item[column])
        ? [...item[column]] // shallow copy for safety
        : [];

      // 🛑 Skip if the value is already present
      if (currentValues.includes(value)) continue;

      // ➕ Add the new value
      const updatedValues = [...currentValues, value];

      // 🏗️ Build the Supabase update call
      const updatePromise = supabase
        .from(table) // dynamic table name
        .update({ [column]: updatedValues }) // update the column with new array
        .eq(matchColumn, itemId) // match by dynamic key (e.g. id)
        .then(({ error }) => {
          if (error) {
            console.error(`❌ Error updating ${table}.${column} for item ${itemId}:`, error.message);
          } else {
            // ✅ Sync local item state
            console.log(`✅ Updated ${column} for ${table} item ${itemId}`);
            item[column] = updatedValues;
          }
        });

      // 🧺 Add this update to the batch
      updates.push(updatePromise);
    }

    // 🚀 Run all updates in parallel
    await Promise.all(updates);
  }

  /** Function that will create the html block for the drop down, insert search bar, attach listener
 * Renders a searchable dropdown and lets the caller define behavior
 * for selecting existing options or creating new ones.
 * @param {Object} config
 * @param {string} config.menuId - ID of the DOM container
 * @param {Array<string>} config.options - Array of string values to display
 * @param {string} [config.searchId="category-search"] - Search input ID
 * @param {string} [config.placeholder="Search..."] - Input placeholder text
 * @param {string} [config.optionClass="dropdown-option"] - Class for each option div
 * @param {string} [config.dataAttribute="cat"] - The data-* attribute key (e.g. "cat", "qr")
 * @param {string} [config.optionsContainerClass="dropdown-options-container"]
 * @param {Function} config.onClick - What to do when any option is clicked (new or existing)
 */
  function renderDropdownOptionsCustom({
    menuId,
    options = [],
    searchId = "category-search",
    placeholder = "Search...",
    optionClass = "dropdown-option",
    dataAttribute = "cat",
    optionsContainerClass = "dropdown-options-container",
    onClick  // 🔥 REQUIRED: single handler for both new and existing
  }) {
    const menu = document.getElementById(menuId);
    if (!menu) return;

    // Initial HTML: search + full list
    menu.innerHTML = `
      <div class="dropdown-search-container">
        <input type="text" id="${searchId}" class="dropdown-search" placeholder="${placeholder}">
      </div>
      <div class="${optionsContainerClass}">
        ${options.map(opt => `
          <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
        `).join("")}
      </div>
    `;

    const input = menu.querySelector(`#${searchId}`);
    const container = menu.querySelector(`.${optionsContainerClass}`);

    // Click handler (delegated to caller)
    const attachClickHandlers = () => {
      container.querySelectorAll(`.${optionClass}[data-${dataAttribute}]`).forEach(optionEl => {
        optionEl.addEventListener("click", () => {
          const value = optionEl.dataset.value;
          const isNew = optionEl.dataset.new === "true";
          syncHiddenInputsWithDropdowns();
          bumpInventoryVersion();
          if (typeof onClick === "function") {
            onClick(value, isNew, optionEl);
          }
        });
      });
    };

    attachClickHandlers(); // Initial options

    // Live search filter + "create new" injection
    input.addEventListener("input", (e) => {
      const search = e.target.value.toLowerCase();
      const filtered = options.filter(opt =>
        opt.toLowerCase().includes(search)
      );

      let html = filtered.map(opt => `
        <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
      `).join("");

      const exactMatch = options.some(opt => opt.toLowerCase() === search);

      if (search && !exactMatch) {
        html += `
          <div class="${optionClass} new-entry" data-${dataAttribute}="${search}" data-value="${search}" data-new="true">
            ➕ Create "${search}"
          </div>
        `;

      }

      container.innerHTML = html;
      attachClickHandlers(); // Re-bind
    });
  }

  //generate wrapper to populate and render the dropdown
  function populateDropdowns({
    data,
    menuId,
    toggleId,
    column,
    optionClass = "dropdown-option",
    optionsContainerClass = "dropdown-options-container",
    searchId = "dropdown-search",
    placeholder = "Search...",
    onClick = null,
    dataAttribute,
    setupToggle = setupDropdownToggle  // 🔧 Optional override!
  }) {
    // 🔸 Extract unique values from the specified column
    const options = extractUniqueFromArrayColumn(data, column);
  
    // 🔸 Render the dropdown with those options
    renderDropdownOptionsCustom({
      menuId,
      options,
      items: data,
      optionClass,
      optionsContainerClass,
      searchId,
      placeholder,
      onClick,
      dataAttribute,
    });

    syncHiddenInputsWithDropdowns();
  
    // 🔸 Setup toggle behavior using either default or custom
    if (typeof setupToggle === "function") {
      setupToggle(toggleId, menuId);
    }
  }
  
//#endregion

/* ================= utilities ============================== */
//#region
//function to get the version from the inventory 
async function getCurrentInventoryVersionFromSupabase() {
  const { data, error } = await supabase
    .from("metadata")
    .select("inventory_version")
    .eq("id", "inventory")
    .single();

  if (error || !data?.inventory_version) {
    console.error("❌ Failed to get inventory version:", error);
    return null;
  }

  return data.inventory_version;
}

//function to only refresh one item at a time
async function refreshItemById(itemId) {
  console.log(`🔄 Refreshing item by ID: ${itemId}`);

  // Step 1: Fetch the updated item
  const { data: items, error: itemError } = await supabase
    .from("item_types")
    .select(getStockItemSelectColumns())
    .eq("id", itemId);

  if (itemError || !items || items.length === 0) {
    console.error("❌ Failed to fetch item:", itemError);
    return;
  }

  const item = items[0];

  // Step 2: Sign photo URLs
  if (Array.isArray(item.photos)) {
    const allArePaths = item.photos.every(p => typeof p === "string" && !p.includes("https://"));
    if (allArePaths) {
      item.photoPaths = item.photos; // ✅ Save raw paths only if they’re real paths
      item.photos = [];              // ✅ Clear it for lazy signing
    } else {
      console.warn("⚠️ Skipped converting signed URLs to paths:", item.photos);
      item.photoPaths = []; // Or leave undefined to skip carousel signing
    }
  }





  // Step 3: Get stock info
  const { data: stockData, error: stockError } = await supabase
    .from("item_stock_locations")
    .select("item_id, quantity, location_id")
    .eq("item_id", itemId);

  if (!stockError && stockData) {
    const [{ data: locations, error: locError }, { data: stores, error: storeError }] = await Promise.all([
      supabase
        .from("locations")
        .select("id, location_name, store_id, is_tray, tray_status, tray_current_store_id"),
      supabase
        .from("store_locations")
        .select("id, name"),
    ]);

    if (!locError && !storeError && locations) {
      const storeMap = Object.fromEntries((stores || []).map(store => [store.id, store.name]));
      const locationMap = Object.fromEntries(locations.map(loc => [loc.id, {
        ...loc,
        label: buildStockLocationLabel(loc, storeMap),
        store_name: storeMap[loc.store_id] || "",
        current_store: storeMap[loc.tray_current_store_id] || storeMap[loc.store_id] || "",
        tray_status_label: TRAY_STATUS_LABELS[loc.tray_status] || "Tray",
      }]));
      const breakdown = {};
      const locationDetails = [];
      let total = 0;

      stockData.forEach(({ quantity, location_id }) => {
        const locationInfo = locationMap[location_id] || {};
        const locName = locationInfo.label || "Unknown Location";
        total += quantity;
        breakdown[locName] = (breakdown[locName] || 0) + quantity;
        locationDetails.push({
          location_id,
          location_name: locationInfo.location_name || locName,
          store_name: locationInfo.store_name || "",
          current_store: locationInfo.current_store || "",
          tray_status_label: locationInfo.tray_status_label || "",
          is_tray: Boolean(locationInfo.is_tray),
          quantity,
        });
      });

      item.stock = total;
      item.stock_location_details = locationDetails;
      item.stock_tooltip = Object.entries(breakdown)
        .map(([loc, qty]) => `${loc}: ${qty}`)
        .join("\n");
    }
  }

  // Step 4: Update it in allItems
  const index = allItems.findIndex(i => i.id === itemId);
  if (index !== -1) {
    allItems[index] = item;
  } else {
    allItems.push(item); // if it's new
  }

  // Step 5: Replace the item card
  const oldCard = document.querySelector(`.stock-card[data-item-id="${itemId}"]`);
  if (oldCard) {
    const newCard = await renderStockCard(item, allItems.findIndex(i => i.id === itemId));
    if (newCard) oldCard.replaceWith(newCard);
    window.lucide.createIcons();
  }
  
  //step 6, update the cache
  const version = await getCurrentInventoryVersionFromSupabase();
  if (version) {
    sessionStorage.setItem(getStockCacheKey(), JSON.stringify({
      version,
      data: allItems
    }));
  }

  console.log("✅ Item refreshed in place:", item.title);
}

//get the signed URL only for the items to be rendered
async function getSignedUrl(path) {
  if (!path || typeof path !== "string") {
    console.warn("❌ Invalid photo path:", path);
    return null;
  }

  const cached = signedUrlCache.get(path);
  if (cached && Date.now() < cached.expiresAt) return cached.url;
  //console.log("🔍 Attempting to sign path:", path);
  const { data, error } = await supabase
    .storage
    .from("photos")
    .createSignedUrl(path, 3600);

  if (error || !data?.signedUrl) {
    console.warn("⚠️ Failed to sign URL:", path, error?.message || "Unknown error");
    return null;
  }

  signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + SIGNED_URL_TTL_MS
  });

  return data.signedUrl;
}

//function to clean cache
function cleanCachedPhotos() {
  const cacheKey = getStockCacheKey();
  const cached = sessionStorage.getItem(cacheKey);
  if (!cached) return;

  try {
    const parsed = JSON.parse(cached);
    if (!Array.isArray(parsed.data)) return;

    parsed.data.forEach(item => {
      if (Array.isArray(item.photos)) {
        const rawPaths = item.photos.filter(p =>
          typeof p === "string" && !p.startsWith("https://")
        );

        item.photoPaths = rawPaths;
        item.photos = []; // clear it to enable lazy signing
      }
    });

    sessionStorage.setItem(cacheKey, JSON.stringify(parsed));
    console.log(`Cleaned photo paths in ${cacheKey}`);
  } catch (err) {
    console.warn("Failed to clean cached stock photos:", err);
  }
}

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

let stockPhotoViewerItemId = null;

function getStockItemById(itemId) {
  return allItems.find((item) => String(item.id) === String(itemId)) || null;
}

function getStockItemPhotoPaths(item) {
  return (Array.isArray(item?.photoPaths) ? item.photoPaths : Array.isArray(item?.photos) ? item.photos : [])
    .filter((path) => typeof path === "string" && path.includes("/"));
}

function setStockPhotoStatus(message, type = "") {
  const status = document.getElementById("stock-photo-manager-status");
  if (!status) return;
  status.textContent = message;
  status.className = type ? `is-${type}` : "";
}

function setStockPhotoProgress(percent = 0, label = "", active = true) {
  const progress = document.getElementById("stock-photo-progress");
  const bar = document.getElementById("stock-photo-progress-bar");
  const labelEl = document.getElementById("stock-photo-progress-label");
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));

  if (progress) {
    progress.classList.toggle("is-active", active);
    progress.setAttribute("aria-hidden", active ? "false" : "true");
  }
  if (bar) bar.style.width = `${clamped}%`;
  if (labelEl) labelEl.textContent = label || (active ? `${Math.round(clamped)}%` : "Idle");
}

function resetStockPhotoProgress() {
  setStockPhotoProgress(0, "Idle", false);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "readonly");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function openBarcodeModal(barcode) {
  const value = String(barcode || "").trim();
  if (!value) {
    showToast("No barcode recorded for this item.");
    return;
  }

  await copyTextToClipboard(value);
  document.getElementById("stock-barcode-full-value").textContent = value;
  document.getElementById("stock-barcode-modal")?.classList.remove("hidden");
  document.getElementById("stock-barcode-modal")?.classList.add("show");
  document.body.classList.add("modal-open");
}

function closeBarcodeModal() {
  document.getElementById("stock-barcode-modal")?.classList.add("hidden");
  document.getElementById("stock-barcode-modal")?.classList.remove("show");
  document.body.classList.remove("modal-open");
}

function openStockDescriptionModal(itemId) {
  const item = findStockItemById(itemId);
  const modal = document.getElementById("stock-description-modal");
  if (!item || !modal) return;

  const title = document.getElementById("stock-description-modal-title");
  const text = document.getElementById("stock-description-modal-text");
  if (title) title.textContent = item.title || "Item Description";
  if (text) text.textContent = String(item.description || "").trim() || "No description recorded.";

  modal.classList.remove("hidden");
  modal.classList.add("show");
  document.body.classList.add("modal-open");
}

function closeStockDescriptionModal() {
  document.getElementById("stock-description-modal")?.classList.add("hidden");
  document.getElementById("stock-description-modal")?.classList.remove("show");
  document.body.classList.remove("modal-open");
}

function stockCanvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not prepare the image."));
    }, type, quality);
  });
}

function stockReadBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image."));
    reader.readAsDataURL(blob);
  });
}

function getStockFileExtension(file) {
  const ext = String(file?.name || "").split(".").pop()?.toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  const type = String(file?.type || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  return "jpg";
}

function getSafeStockUploadName(file) {
  const baseName = String(file?.name || "stock-photo")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80) || "stock-photo";
  return `${baseName}.${getStockFileExtension(file)}`;
}

function loadStockImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the image."));
    image.src = src;
  });
}

async function prepareStockUploadBlob(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Choose a valid image file.");
  }

  const canUploadDirectly = file.size <= STOCK_LOCAL_UPLOAD_MAX_DIRECT_BYTES
    && /image\/(png|jpe?g|webp)/i.test(file.type || "");
  if (canUploadDirectly) {
    return {
      blob: file,
      mimeType: file.type || "image/jpeg",
      fileName: getSafeStockUploadName(file),
    };
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadStockImageElement(sourceUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, STOCK_LOCAL_UPLOAD_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser image preparation is not available.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      blob: await stockCanvasToBlob(canvas, "image/jpeg", 0.94),
      mimeType: "image/jpeg",
      fileName: getSafeStockUploadName(file).replace(/\.(png|webp)$/i, ".jpg"),
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function uploadStockPhotoFile(file) {
  const prepared = await prepareStockUploadBlob(file);
  return await uploadStockPhotoBlob(prepared.blob, prepared.fileName, prepared.mimeType);
}

async function uploadStockPhotoBlob(blob, fileName = "stock-photo.jpg", mimeType = "image/jpeg") {
  const type = mimeType || blob?.type || "image/jpeg";
  const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const baseName = String(fileName || "stock-photo")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.\-]+/g, "_") || "stock-photo";
  const safeName = `${baseName}.${extension}`;
  const uploadPath = `item_photos/${stockMediaState.itemId}-${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage
    .from(STOCK_PHOTO_BUCKET)
    .upload(uploadPath, blob, {
      upsert: true,
      contentType: type,
    });

  if (error) throw new Error(error.message || "Photo upload failed.");

  signedUrlCache.delete(uploadPath);
  return {
    path: uploadPath,
    name: fileName || safeName,
    previewUrl: await getSignedUrl(uploadPath),
    sourceType: "uploaded",
  };
}

async function getStockFunctionErrorDetail(error) {
  try {
    const response = error?.context?.response;
    if (response?.clone) {
      const payload = await response.clone().json();
      return String(payload?.detail || payload?.error || payload?.message || "").trim();
    }
  } catch (detailError) {
    console.warn("Could not read image processor error:", detailError);
  }
  return String(error?.message || "").trim();
}

async function loadStockBackgroundRemoval() {
  if (!stockBackgroundRemovalModulePromise) {
    stockBackgroundRemovalModulePromise = import(STOCK_BACKGROUND_REMOVAL_MODULE_URL)
      .then((module) => module.default || module.removeBackground || module);
  }
  return stockBackgroundRemovalModulePromise;
}

async function createStockObjectUrl(previewUrl) {
  const response = await fetch(previewUrl);
  if (!response.ok) throw new Error(`Could not download the image (${response.status}).`);
  const blob = await response.blob();
  const imageUrl = URL.createObjectURL(blob);
  return {
    imageUrl,
    revoke: () => URL.revokeObjectURL(imageUrl),
  };
}

async function createStockSourceBlobForBackgroundRemoval(image) {
  const objectUrl = await createStockObjectUrl(image.previewUrl);
  try {
    const sourceImage = await loadStockImageElement(objectUrl.imageUrl);
    const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
    const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
    const scale = Math.min(1, STOCK_BACKGROUND_MAX_SOURCE_SIDE / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser image processing is not available.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    return await stockCanvasToBlob(canvas, "image/png", 0.95);
  } finally {
    objectUrl.revoke();
  }
}

async function createStockBackgroundPayload(image, background, options = {}) {
  options.onProgress?.(10, "Preparing image...");
  const sourceBlob = await createStockSourceBlobForBackgroundRemoval(image);
  options.onProgress?.(18, "Loading background remover...");
  const removeBackground = await loadStockBackgroundRemoval();
  options.onProgress?.(25, "Removing background...");
  const cutoutBlob = await removeBackground(sourceBlob, {
    model: "isnet_fp16",
    output: {
      format: "image/png",
      quality: 0.95,
      type: "foreground",
    },
    progress: (key, current, total) => {
      if (!total) return;
      const percent = 25 + Math.round((current / total) * 45);
      options.onProgress?.(percent, "Removing background...");
    },
  });

  const cutoutUrl = URL.createObjectURL(cutoutBlob);
  try {
    options.onProgress?.(74, `Compositing ${background} background...`);
    const cutout = await loadStockImageElement(cutoutUrl);
    const width = cutout.naturalWidth || cutout.width;
    const height = cutout.naturalHeight || cutout.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser image compositing is not available.");
    context.fillStyle = background === "black" ? "#000000" : "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(cutout, 0, 0, width, height);
    const processedBlob = await stockCanvasToBlob(canvas, "image/png", 0.95);
    const dataUrl = await stockReadBlobAsDataUrl(processedBlob);
    const processedImageBase64 = dataUrl.split(",")[1] || "";
    if (!processedImageBase64) throw new Error("Background processor returned an empty image.");
    options.onProgress?.(86, "Uploading processed version...");
    return {
      processedImageBase64,
      processedMimeType: processedBlob.type || "image/png",
    };
  } finally {
    URL.revokeObjectURL(cutoutUrl);
  }
}

function renderStockPhotoManagerGrid() {
  const grid = document.getElementById("stock-photo-manager-grid");
  const selectedCount = document.getElementById("stock-photo-selected-count");
  if (!grid) return;

  if (selectedCount) {
    selectedCount.textContent = `${stockMediaState.selectedPaths.size} selected`;
  }

  if (!stockMediaState.stagedImages.length) {
    grid.innerHTML = `<div class="stock-photo-empty">Choose photos to start. Black background versions are prepared automatically.</div>`;
    return;
  }

  grid.innerHTML = stockMediaState.stagedImages.map((image, index) => {
    const isSelected = stockMediaState.selectedPaths.has(image.path);
    return `
      <article class="stock-photo-candidate ${isSelected ? "is-selected" : ""}" data-index="${index}">
        <button type="button" class="stock-photo-candidate-image" data-action="preview" data-index="${index}">
          <img src="${escapeStockHtml(image.previewUrl || "")}" alt="${escapeStockHtml(image.name || "Item photo")}">
        </button>
        <div class="stock-photo-candidate-body">
          <strong>${escapeStockHtml(image.name || "Item photo")}</strong>
          <small>${escapeStockHtml(image.sourceType || "photo")}</small>
        </div>
        <div class="stock-photo-candidate-actions">
          <button type="button" data-action="toggle" data-index="${index}">${isSelected ? "Selected" : "Use"}</button>
          <button type="button" data-action="edit" data-index="${index}">Edit</button>
          <button type="button" data-action="black" data-index="${index}">Black</button>
          <button type="button" data-action="white" data-index="${index}">White</button>
        </div>
      </article>
    `;
  }).join("");
}

function closeStockPhotoEditor() {
  const editor = document.getElementById("stock-photo-editor");
  editor?.classList.add("hidden");
  stockMediaState.editor = {
    index: -1,
    image: null,
    imageElement: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
  };
}

function syncStockEditorControls() {
  document.getElementById("stock-photo-editor-zoom").value = String(stockMediaState.editor.zoom);
  document.getElementById("stock-photo-editor-x").value = String(stockMediaState.editor.offsetX);
  document.getElementById("stock-photo-editor-y").value = String(stockMediaState.editor.offsetY);
}

function drawStockPhotoEditor() {
  const canvas = document.getElementById("stock-photo-editor-canvas");
  const image = stockMediaState.editor.imageElement;
  if (!canvas || !image) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const size = canvas.width;
  const baseScale = Math.min(size / image.width, size / image.height);
  const scale = baseScale * stockMediaState.editor.zoom;
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const maxOffset = size * 0.42;
  const x = size / 2 + stockMediaState.editor.offsetX * maxOffset;
  const y = size / 2 + stockMediaState.editor.offsetY * maxOffset;

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#101014";
  context.fillRect(0, 0, size, size);
  context.save();
  context.translate(x, y);
  context.rotate(stockMediaState.editor.rotation * Math.PI / 180);
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}

async function openStockPhotoEditor(index) {
  const image = stockMediaState.stagedImages[index];
  if (!image?.previewUrl) return;

  setStockPhotoStatus("Opening editor. Crop, recenter, or rotate the photo.", "waiting");
  const objectUrl = await createStockObjectUrl(image.previewUrl);
  try {
    const imageElement = await loadStockImageElement(objectUrl.imageUrl);
    stockMediaState.editor = {
      index,
      image,
      imageElement,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
    };
    document.getElementById("stock-photo-editor")?.classList.remove("hidden");
    syncStockEditorControls();
    drawStockPhotoEditor();
    setStockPhotoStatus("Editor ready. Adjust the crop, then use the edited photo.", "success");
  } finally {
    objectUrl.revoke();
  }
}

async function saveStockPhotoEditorImage() {
  if (!stockMediaState.editor.imageElement || stockMediaState.editor.index < 0) {
    setStockPhotoStatus("Open a photo in the editor first.", "error");
    return;
  }

  setStockPhotoStatus("Saving edited photo...", "waiting");
  setStockPhotoProgress(12, "Rendering edited crop...", true);

  try {
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = STOCK_EDITOR_OUTPUT_SIZE;
    outputCanvas.height = STOCK_EDITOR_OUTPUT_SIZE;
    const outputContext = outputCanvas.getContext("2d");
    if (!outputContext) throw new Error("Browser image editor is not available.");

    const previewCanvas = document.getElementById("stock-photo-editor-canvas");
    if (!previewCanvas) throw new Error("Editor canvas is not available.");
    outputContext.drawImage(previewCanvas, 0, 0, outputCanvas.width, outputCanvas.height);

    const blob = await stockCanvasToBlob(outputCanvas, "image/png", 0.95);
    setStockPhotoProgress(45, "Uploading edited photo...", true);
    const uploaded = await uploadStockPhotoBlob(blob, `edited-${stockMediaState.editor.image?.name || "stock-photo"}.png`, "image/png");
    uploaded.sourceType = "edited crop";
    stockMediaState.stagedImages.unshift(uploaded);
    stockMediaState.selectedPaths.add(uploaded.path);
    renderStockPhotoManagerGrid();
    closeStockPhotoEditor();
    setStockPhotoStatus("Edited photo is ready and selected.", "success");
    setStockPhotoProgress(100, "Edited photo ready.", true);
    setTimeout(resetStockPhotoProgress, 900);
  } catch (error) {
    console.error("Stock photo editor save failed:", error);
    setStockPhotoStatus(error?.message || "Could not save edited photo.", "error");
    setStockPhotoProgress(100, "Editor save failed.", true);
  }
}

async function processStockStagedImage(index, background, options = {}) {
  const source = stockMediaState.stagedImages[index];
  if (!source || !source.path || !source.previewUrl) return null;

  stockMediaState.busy = true;
  setStockPhotoStatus(`Preparing ${background} background version...`, "waiting");
  setStockPhotoProgress(5, `Starting ${background} background...`, true);
  renderStockPhotoManagerGrid();
  window.dispatchEvent(new CustomEvent("stock:photo-processing-requested", {
    detail: { itemId: stockMediaState.itemId, sourcePath: source.path, background },
  }));

  try {
    const payload = await createStockBackgroundPayload(source, background, {
      onProgress: (percent, label) => setStockPhotoProgress(percent, label, true),
    });
    const { data, error } = await supabase.functions.invoke(STOCK_IMAGE_PROCESS_FUNCTION_NAME, {
      body: {
        bucket: STOCK_PHOTO_BUCKET,
        imagePath: source.path,
        background,
        ...payload,
      },
    });

    if (error) throw new Error(await getStockFunctionErrorDetail(error) || "Background processing failed.");
    if (!data?.ok || !data?.path || !data?.bucket) {
      throw new Error(data?.detail || data?.error || "Background processor returned no image.");
    }

    signedUrlCache.delete(data.path);
    const processed = {
      path: data.path,
      name: data.name || `${background} background`,
      previewUrl: data.previewUrl || await getSignedUrl(data.path),
      sourceType: `${background} background`,
    };
    stockMediaState.stagedImages.unshift(processed);
    if (options.autoSelect !== false) {
      stockMediaState.selectedPaths.add(processed.path);
      if (options.replaceSourceSelection !== false) {
        stockMediaState.selectedPaths.delete(source.path);
      }
    }
    setStockPhotoStatus(`${background[0].toUpperCase()}${background.slice(1)} background version is ready.`, "success");
    setStockPhotoProgress(100, "Processed version ready.", true);
    renderStockPhotoManagerGrid();
    setTimeout(resetStockPhotoProgress, 900);
    return processed;
  } catch (error) {
    console.error("Stock photo background processing failed:", error);
    setStockPhotoStatus(error?.message || "Could not process the background.", "error");
    setStockPhotoProgress(100, "Processing failed.", true);
    return null;
  } finally {
    stockMediaState.busy = false;
  }
}

async function handleStockPhotoFiles(files) {
  const fileList = Array.from(files || []);
  if (!stockMediaState.itemId || !fileList.length) return;

  for (let index = 0; index < fileList.length; index += 1) {
    const file = fileList[index];
    setStockPhotoStatus(`Uploading photo ${index + 1} of ${fileList.length}...`, "waiting");
    setStockPhotoProgress(8, `Uploading ${index + 1} of ${fileList.length}...`, true);
    try {
      const uploaded = await uploadStockPhotoFile(file);
      setStockPhotoProgress(32, "Upload complete. Preparing black background...", true);
      stockMediaState.stagedImages.unshift(uploaded);
      stockMediaState.selectedPaths.add(uploaded.path);
      renderStockPhotoManagerGrid();
      await processStockStagedImage(0, "black", { autoSelect: true, replaceSourceSelection: true });
    } catch (error) {
      console.error("Stock photo upload failed:", error);
      setStockPhotoStatus(error?.message || "Could not upload one of the photos.", "error");
      setStockPhotoProgress(100, "Upload failed.", true);
    }
  }
}

async function openStockPhotoManager(itemId) {
  const item = getStockItemById(itemId);
  stockMediaState.itemId = itemId;
  stockMediaState.stagedImages = [];
  stockMediaState.selectedPaths = new Set();
  stockMediaState.selectedCaptureStationId = "";
  document.getElementById("stock-photo-manager-title").textContent = `Add Photos${item?.title ? `: ${item.title}` : ""}`;
  document.getElementById("stock-photo-upload-input").value = "";
  setStockPhotoStatus("Upload photos, review the processed versions, then save only the ones you want.");
  resetStockPhotoProgress();
  closeStockPhotoEditor();
  renderStockPhotoManagerGrid();
  document.getElementById("stock-photo-manager-modal")?.classList.remove("hidden");
  document.getElementById("stock-photo-manager-modal")?.classList.add("show");
  document.body.classList.add("modal-open");
  loadStockCaptureStations({ silent: true }).catch((error) => {
    console.error("Failed to load stock capture stations:", error);
    setStockPhotoStatus(error?.message || "Could not load camera stations.", "error");
  });
}

function closeStockPhotoManager() {
  document.getElementById("stock-photo-manager-modal")?.classList.add("hidden");
  document.getElementById("stock-photo-manager-modal")?.classList.remove("show");
  document.body.classList.remove("modal-open");
  closeStockPhotoEditor();
  resetStockPhotoProgress();
}

async function saveSelectedStockPhotos() {
  const itemId = stockMediaState.itemId;
  const selectedPaths = [...stockMediaState.selectedPaths];
  if (!itemId || !selectedPaths.length) {
    setStockPhotoStatus("Select at least one photo before saving.", "error");
    return;
  }

  const confirmed = window.confirm(
    `Are you sure you want to add ${selectedPaths.length} selected photo${selectedPaths.length === 1 ? "" : "s"} to this item?`
  );
  if (!confirmed) {
    setStockPhotoStatus("Photo save cancelled. Your selections are still here.", "waiting");
    return;
  }

  setStockPhotoStatus("Saving selected photos to the item...", "waiting");
  let saveResult;
  if (canViewSensitiveStockData()) {
    const { data: items, error: fetchError } = await supabase
      .from("item_types")
      .select("id, photos")
      .eq("id", itemId)
      .limit(1);

    if (fetchError || !items?.length) {
      saveResult = { error: fetchError || new Error("Could not load the item before saving.") };
    } else {
      const existingPhotos = Array.isArray(items[0].photos) ? items[0].photos : [];
      const nextPhotos = [...new Set([...existingPhotos, ...selectedPaths])];
      saveResult = await supabase
        .from("item_types")
        .update({ photos: nextPhotos })
        .eq("id", itemId);
    }
  } else {
    saveResult = await supabase.rpc("append_item_photos", {
      _item_id: itemId,
      _photo_paths: selectedPaths,
    });
  }

  const { error } = saveResult;

  if (error) {
    setStockPhotoStatus(error.message || "Could not save photos.", "error");
    return;
  }

  await bumpInventoryVersion([itemId]);
  await refreshItemById(itemId);
  window.dispatchEvent(new CustomEvent("stock:photos-added", {
    detail: { itemId, photoPaths: selectedPaths },
  }));
  showToast("Photos added to item.");
  closeStockPhotoManager();
}

function delayStockCapture(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderStockCaptureStations() {
  const select = document.getElementById("stock-photo-camera-station");
  if (!select) return;

  const stations = stockMediaState.captureStations;
  if (!stations.length) {
    select.innerHTML = '<option value="">No active stations</option>';
    select.disabled = true;
    return;
  }

  select.replaceChildren(new Option("Choose station", ""));
  stations.forEach((station) => {
    select.appendChild(new Option(station.name || station.id, station.id));
  });
  select.disabled = false;
  select.value = stations.some((station) => station.id === stockMediaState.selectedCaptureStationId)
    ? stockMediaState.selectedCaptureStationId
    : "";
}

function setSelectedStockCaptureStation(stationId = "") {
  const station = stockMediaState.captureStations.find((entry) => entry.id === stationId) || null;
  stockMediaState.selectedCaptureStationId = station?.id || "";

  const select = document.getElementById("stock-photo-camera-station");
  if (select && select.value !== stockMediaState.selectedCaptureStationId) {
    select.value = stockMediaState.selectedCaptureStationId;
  }

  try {
    if (station) {
      window.localStorage?.setItem("og.captureStationId", station.id);
      window.localStorage?.setItem("og.captureStationName", station.name || "");
    }
  } catch (_) {}

  return station;
}

async function loadStockCaptureStations(options = {}) {
  const { silent = false } = options;
  const select = document.getElementById("stock-photo-camera-station");
  if (select) {
    select.disabled = true;
    select.innerHTML = '<option value="">Loading stations...</option>';
  }

  const { data, error } = await supabase
    .from(STOCK_CAPTURE_STATION_TABLE)
    .select("id, name, active")
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message || "Could not load capture stations.");
  stockMediaState.captureStations = Array.isArray(data) ? data : [];

  if (!stockMediaState.captureStations.some((station) => station.id === stockMediaState.selectedCaptureStationId)) {
    stockMediaState.selectedCaptureStationId = "";
  }

  renderStockCaptureStations();

  if (!stockMediaState.captureStations.length) {
    if (!silent) setStockPhotoStatus("No active capture stations are available.", "error");
    return [];
  }

  if (!silent) setStockPhotoStatus("Choose which camera station should take this photo.", "waiting");
  return stockMediaState.captureStations;
}

function getSelectedStockCaptureStation() {
  return stockMediaState.captureStations.find((station) => station.id === stockMediaState.selectedCaptureStationId) || null;
}

async function createStockCaptureJob(stationId) {
  const { data, error } = await supabase
    .from(STOCK_CAPTURE_JOB_TABLE)
    .insert({
      station_id: stationId,
      status: "queued",
      requested_at: new Date().toISOString(),
    })
    .select("id, station_id, status, requested_at")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create capture job.");
  return data;
}

function stockCaptureJobHasUpload(job) {
  return Boolean(job?.storage_bucket && job?.storage_path)
    || Boolean(job?.upload_completed_at)
    || Boolean(job?.capture_completed_at && job?.storage_path);
}

async function getStockCaptureJobPhotoCount(jobId) {
  const { count, error } = await supabase
    .from(STOCK_CAPTURE_PHOTO_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("capture_job_id", jobId);

  if (error) {
    console.warn("Could not check capture photo count:", error);
    return 0;
  }

  return count || 0;
}

async function findRecentStockCaptureCompletion(stationId, requestedAt) {
  if (!stationId || !requestedAt) return null;

  const requestedMs = new Date(requestedAt).getTime();
  const lookbackIso = Number.isFinite(requestedMs)
    ? new Date(requestedMs - STOCK_CAPTURE_FALLBACK_LOOKBACK_MS).toISOString()
    : requestedAt;

  const { data, error } = await supabase
    .from(STOCK_CAPTURE_JOB_TABLE)
    .select(`
      id,
      station_id,
      status,
      storage_bucket,
      storage_path,
      capture_completed_at,
      upload_completed_at,
      mime_type,
      file_size_bytes,
      failure_code,
      failure_message,
      requested_at
    `)
    .eq("station_id", stationId)
    .gte("requested_at", lookbackIso)
    .order("requested_at", { ascending: false })
    .limit(5);

  if (error) {
    console.warn("Could not check recent capture jobs:", error);
    return null;
  }

  const jobs = Array.isArray(data) ? data : [];
  for (const job of jobs) {
    if (job.status === "failed") continue;
    if (job.status === "completed" || stockCaptureJobHasUpload(job) || await getStockCaptureJobPhotoCount(job.id)) {
      return { ...job, status: "completed" };
    }
  }

  return null;
}

async function pollStockCaptureJob(job, station = {}) {
  const jobId = typeof job === "object" ? job.id : job;
  const stationId = station.id || job?.station_id || "";
  const stationName = station.name || "";
  const requestedAt = job?.requested_at || "";
  const startedAt = Date.now();

  while ((Date.now() - startedAt) < STOCK_CAPTURE_POLL_TIMEOUT_MS) {
    const { data, error } = await supabase
      .from(STOCK_CAPTURE_JOB_TABLE)
      .select(`
        id,
        station_id,
        status,
        storage_bucket,
        storage_path,
        capture_completed_at,
        upload_completed_at,
        mime_type,
        file_size_bytes,
        failure_code,
        failure_message,
        requested_at
      `)
      .eq("id", jobId)
      .single();

    if (error || !data) throw new Error(error?.message || "Failed to poll capture job.");
    if (data.status === "completed" || data.status === "failed") return data;
    if (stockCaptureJobHasUpload(data) || await getStockCaptureJobPhotoCount(jobId)) {
      return { ...data, status: "completed" };
    }

    const fallbackJob = await findRecentStockCaptureCompletion(stationId, requestedAt);
    if (fallbackJob && fallbackJob.id !== jobId) {
      return fallbackJob;
    }

    const stationLabel = stationName ? ` on ${stationName}` : "";
    const label = data.status === "queued"
      ? `Capture queued${stationLabel}. Waiting for camera...`
      : data.status === "capturing"
        ? `Camera is capturing${stationLabel}...`
        : data.status === "uploading"
          ? `Camera is uploading${stationLabel}...`
          : `Capture status: ${data.status || "waiting"}`;
    setStockPhotoStatus(label, "waiting");
    setStockPhotoProgress(data.status === "queued" ? 20 : data.status === "capturing" ? 45 : 68, label, true);
    await delayStockCapture(STOCK_CAPTURE_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for camera capture.");
}

async function loadStockCaptureJobPhotos(jobId) {
  const { data, error } = await supabase
    .from(STOCK_CAPTURE_PHOTO_TABLE)
    .select("id, capture_job_id, sort_order, is_primary, storage_bucket, storage_path, mime_type, label, created_at")
    .eq("capture_job_id", jobId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(error.message || "Failed to load capture photos.");
  return Array.isArray(data) ? data : [];
}

async function importCapturedPhotoToStock(photo, index = 0) {
  const bucket = String(photo?.storage_bucket || "").trim();
  const path = String(photo?.storage_path || "").trim();
  if (!bucket || !path) throw new Error("Captured photo is missing storage metadata.");

  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message || "Could not download captured photo.");

  const name = String(photo?.label || `camera-capture-${index + 1}.jpg`).trim();
  const uploaded = await uploadStockPhotoBlob(data, name, photo?.mime_type || data.type || "image/jpeg");
  uploaded.sourceType = "camera capture";
  return uploaded;
}

async function requestStockCameraCapture() {
  if (!stockMediaState.itemId || stockMediaState.busy) return;

  stockMediaState.busy = true;
  setStockPhotoStatus("Sending camera request to the OG app...", "waiting");
  setStockPhotoProgress(12, "Sending camera request...", true);

  try {
    if (!stockMediaState.captureStations.length) {
      await loadStockCaptureStations({ silent: true });
    }

    const station = getSelectedStockCaptureStation();
    if (!station) {
      resetStockPhotoProgress();
      setStockPhotoStatus("Choose the camera station before sending the request.", "error");
      document.getElementById("stock-photo-camera-station")?.focus();
      return;
    }

    const job = await createStockCaptureJob(station.id);
    stockMediaState.latestCaptureJob = job;

    window.dispatchEvent(new CustomEvent("assisted:iphone-capture-requested", {
      detail: {
        source: "stock-photo-manager",
        itemId: stockMediaState.itemId,
        stationId: station.id,
        stationName: station.name || "",
        jobId: job.id,
      },
    }));

    const completedJob = await pollStockCaptureJob(job, station);
    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || completedJob.failure_code || "Capture failed.");
    }

    setStockPhotoProgress(78, "Loading captured photos...", true);
    const capturePhotos = await loadStockCaptureJobPhotos(completedJob.id);
    if (!capturePhotos.length && completedJob.storage_bucket && completedJob.storage_path) {
      capturePhotos.push({
        storage_bucket: completedJob.storage_bucket,
        storage_path: completedJob.storage_path,
        label: "Camera capture",
      });
    }
    if (!capturePhotos.length) throw new Error("Camera completed, but no uploaded photos were returned.");

    for (let index = 0; index < capturePhotos.length; index += 1) {
      const uploaded = await importCapturedPhotoToStock(capturePhotos[index], index);
      stockMediaState.stagedImages.unshift(uploaded);
      stockMediaState.selectedPaths.add(uploaded.path);
      renderStockPhotoManagerGrid();
      await processStockStagedImage(0, "black", { autoSelect: true, replaceSourceSelection: true });
    }

    setStockPhotoStatus(`Loaded ${capturePhotos.length} camera photo${capturePhotos.length === 1 ? "" : "s"}.`, "success");
    setStockPhotoProgress(100, "Camera photos loaded.", true);
    setTimeout(resetStockPhotoProgress, 900);
  } catch (error) {
    console.error("Stock camera capture failed:", error);
    setStockPhotoStatus(error?.message || "Could not complete camera capture.", "error");
    setStockPhotoProgress(100, "Camera capture failed.", true);
  } finally {
    stockMediaState.busy = false;
  }
}

async function openStockPhotoViewer(itemId, startPath = "") {
  const item = getStockItemById(itemId);
  const paths = getStockItemPhotoPaths(item);
  if (!item || !paths.length) {
    openStockPhotoManager(itemId);
    return;
  }

  stockPhotoViewerItemId = itemId;
  document.getElementById("stock-photo-viewer-title").textContent = item.title || "Item Photos";
  const modal = document.getElementById("stock-photo-viewer-modal");
  const image = document.getElementById("stock-photo-viewer-image");
  const thumbs = document.getElementById("stock-photo-viewer-thumbs");
  thumbs.innerHTML = "";

  const signed = await Promise.all(paths.map(async (path) => ({
    path,
    url: await getSignedUrl(path),
  })));

  function showPath(path) {
    const entry = signed.find((photo) => photo.path === path) || signed[0];
    if (!entry?.url) return;
    image.src = entry.url;
    thumbs.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.path === entry.path);
    });
  }

  signed.forEach((entry) => {
    if (!entry.url) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.path = entry.path;
    button.innerHTML = `<img src="${entry.url}" alt="Item thumbnail">`;
    button.addEventListener("click", () => showPath(entry.path));
    thumbs.appendChild(button);
  });

  modal?.classList.remove("hidden");
  modal?.classList.add("show");
  document.body.classList.add("modal-open");
  showPath(startPath || paths[0]);
}

function closeStockPhotoViewer() {
  document.getElementById("stock-photo-viewer-modal")?.classList.add("hidden");
  document.getElementById("stock-photo-viewer-modal")?.classList.remove("show");
  document.body.classList.remove("modal-open");
}

function setupStockMediaListeners() {
  document.getElementById("close-stock-photo-viewer")?.addEventListener("click", closeStockPhotoViewer);
  document.getElementById("close-stock-photo-manager")?.addEventListener("click", closeStockPhotoManager);
  document.getElementById("close-stock-barcode-modal")?.addEventListener("click", closeBarcodeModal);
  document.getElementById("close-stock-description-modal")?.addEventListener("click", closeStockDescriptionModal);
  document.getElementById("stock-description-modal")?.addEventListener("click", (event) => {
    if (event.target?.id === "stock-description-modal") closeStockDescriptionModal();
  });
  document.getElementById("stock-photo-viewer-add")?.addEventListener("click", () => {
    if (stockPhotoViewerItemId) {
      const itemId = stockPhotoViewerItemId;
      closeStockPhotoViewer();
      openStockPhotoManager(itemId);
    }
  });
  document.getElementById("stock-photo-upload-input")?.addEventListener("change", (event) => {
    handleStockPhotoFiles(event.target.files);
  });
  document.getElementById("stock-photo-camera-station")?.addEventListener("change", (event) => {
    const station = setSelectedStockCaptureStation(event.target.value);
    setStockPhotoStatus(station
      ? `Camera requests will route to ${station.name || station.id}.`
      : "Choose which camera station should take this photo.", station ? "success" : "waiting");
  });
  document.getElementById("stock-photo-camera-refresh")?.addEventListener("click", async () => {
    if (stockMediaState.busy) return;
    try {
      setStockPhotoStatus("Refreshing camera stations...", "waiting");
      await loadStockCaptureStations();
    } catch (error) {
      console.error("Failed to refresh stock capture stations:", error);
      setStockPhotoStatus(error?.message || "Could not refresh camera stations.", "error");
    }
  });
  document.getElementById("stock-photo-camera-request")?.addEventListener("click", requestStockCameraCapture);
  document.getElementById("stock-photo-save-selection")?.addEventListener("click", saveSelectedStockPhotos);
  ["stock-photo-editor-zoom", "stock-photo-editor-x", "stock-photo-editor-y"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (id.endsWith("zoom")) stockMediaState.editor.zoom = value;
      if (id.endsWith("-x")) stockMediaState.editor.offsetX = value;
      if (id.endsWith("-y")) stockMediaState.editor.offsetY = value;
      drawStockPhotoEditor();
    });
  });
  document.getElementById("stock-photo-editor-rotate-left")?.addEventListener("click", () => {
    stockMediaState.editor.rotation -= 5;
    drawStockPhotoEditor();
  });
  document.getElementById("stock-photo-editor-rotate-right")?.addEventListener("click", () => {
    stockMediaState.editor.rotation += 5;
    drawStockPhotoEditor();
  });
  document.getElementById("stock-photo-editor-reset")?.addEventListener("click", () => {
    stockMediaState.editor.zoom = 1;
    stockMediaState.editor.offsetX = 0;
    stockMediaState.editor.offsetY = 0;
    stockMediaState.editor.rotation = 0;
    syncStockEditorControls();
    drawStockPhotoEditor();
  });
  document.getElementById("stock-photo-editor-save")?.addEventListener("click", saveStockPhotoEditorImage);
  document.getElementById("stock-photo-manager-grid")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || stockMediaState.busy) return;
    const index = Number(button.dataset.index);
    const action = button.dataset.action;
    const image = stockMediaState.stagedImages[index];
    if (!image) return;
    if (action === "toggle") {
      if (stockMediaState.selectedPaths.has(image.path)) stockMediaState.selectedPaths.delete(image.path);
      else stockMediaState.selectedPaths.add(image.path);
      renderStockPhotoManagerGrid();
    } else if (action === "black" || action === "white") {
      await processStockStagedImage(index, action, { autoSelect: true, replaceSourceSelection: false });
    } else if (action === "edit") {
      await openStockPhotoEditor(index);
    } else if (action === "preview") {
      window.open(image.previewUrl, "_blank", "noopener,noreferrer");
    }
  });
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

// 🔹 Utility Function: Fetch all inventory items from Supabase item-types
// ✅ Returns: An array of item objects from the "item_types" table
// ✅ Usage: Server or client-side logic can call this to get item data
// ✅ Side-effect-free: Doesn't modify state or interact with the DOM
async function fetchStockItems() {
  // Step 1: Get base item data
  const { data: items, error: itemError } = await supabase
    .from("item_types")
    .select(getStockItemSelectColumns());

  if (itemError || !items) {
    console.error("❌ Failed to fetch item types:", itemError);
    return [];
  }

  // Step 1.5: Generate signed image URLs from stored paths
  for (const item of items) {
    if (Array.isArray(item.photos)) {
      const allArePaths = item.photos.every(p => typeof p === "string" && !p.includes("https://"));
      if (allArePaths) {
        item.photoPaths = item.photos; // ✅ Save raw paths only if they’re real paths
        item.photos = [];              // ✅ Clear it for lazy signing
      } else {
        console.warn("⚠️ Skipped converting signed URLs to paths:", item.photos);
        item.photoPaths = []; // Or leave undefined to skip carousel signing
      }
    }



  }

  // Step 2: Fetch stock quantities
  const { data: stockData, error: stockError } = await supabase
    .from("item_stock_locations")
    .select("item_id, quantity, location_id");

  if (stockError || !stockData) {
    console.error("❌ Failed to fetch stock quantities:", stockError);
    return items;
  }

  // Step 3: Fetch location name map
  const [{ data: locations, error: locError }, { data: stores, error: storeError }] = await Promise.all([
    supabase
      .from("locations")
      .select("id, location_name, store_id, is_tray, tray_status, tray_current_store_id"),
    supabase
      .from("store_locations")
      .select("id, name"),
  ]);

  if (locError || storeError || !locations) {
    console.error("❌ Failed to fetch location names:", locError);
    return items;
  }

  const storeMap = Object.fromEntries((stores || []).map(store => [store.id, store.name]));
  const locationMap = Object.fromEntries(locations.map(loc => [loc.id, {
    ...loc,
    label: buildStockLocationLabel(loc, storeMap),
    store_name: storeMap[loc.store_id] || "",
    current_store: storeMap[loc.tray_current_store_id] || storeMap[loc.store_id] || "",
    tray_status_label: TRAY_STATUS_LABELS[loc.tray_status] || "Tray",
  }]));

  // Step 4: Aggregate stock per item
  const stockMap = {};
  stockData.forEach(({ item_id, quantity, location_id }) => {
    const locationInfo = locationMap[location_id] || {};
    const locName = locationInfo.label || "Unknown Location";
    if (!stockMap[item_id]) {
      stockMap[item_id] = { total: 0, breakdown: {}, details: [] };
    }
    stockMap[item_id].total += quantity;
    stockMap[item_id].breakdown[locName] = (stockMap[item_id].breakdown[locName] || 0) + quantity;
    stockMap[item_id].details.push({
      location_id,
      location_name: locationInfo.location_name || locName,
      store_name: locationInfo.store_name || "",
      current_store: locationInfo.current_store || "",
      tray_status_label: locationInfo.tray_status_label || "",
      is_tray: Boolean(locationInfo.is_tray),
      quantity,
    });
  });

  // Step 5: Inject stock and tooltip
  items.forEach(item => {
    const stockEntry = stockMap[item.id];
    item.stock = stockEntry?.total || 0;
    item.stock_location_details = stockEntry?.details || [];

    if (stockEntry) {
      item.stock_tooltip = Object.entries(stockEntry.breakdown)
        .map(([loc, qty]) => `${loc}: ${qty}`)
        .join("\n");
    } else {
      item.stock_tooltip = "No stock data available";
    }

    item.stock_locations = Object.keys(stockEntry?.breakdown || {}); // ← ✅ this is the key line
  });
  

  return items;
}

// use the cache to load all the items and improve the user experience
async function loadAllItemsWithCache() {
  const overlay = document.getElementById("loading-overlay");
  overlay.style.display = "flex"; // ✅ Show loading

  const cacheKey = getStockCacheKey();
  const cached = sessionStorage.getItem(cacheKey);
  const currentVersion = await getCurrentInventoryVersionFromSupabase();
  

  if (!currentVersion) {
    console.warn("⚠️ No version info — fallback to live fetch.");
    allItems = await fetchStockItems(); // fallback load
    overlay.style.display = "none"; // ✅ Hide loading
    return;
  }

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.version === currentVersion && Array.isArray(parsed.data)) {
        console.log("✅ Loaded allItems from cache");
        allItems = parsed.data;
        overlay.style.display = "none"; // ✅ Hide loading
        return;
      } else {
        console.log("🌀 Version mismatch — reloading from Supabase");
      }
    } catch (e) {
      console.warn("⚠️ Failed to parse cached items:", e);
    }
  }

  // If no cache or version mismatch, fetch live
  allItems = await fetchStockItems();

  // Then store it in session cache
  sessionStorage.setItem(cacheKey, JSON.stringify({
    version: currentVersion,
    data: allItems
  }));

  overlay.style.display = "none"; // ✅ Hide loading
}

//function to change the version of the metadata the cache uses after each operation 
async function bumpInventoryVersion(changedIds = null) {
  const payload = {
    inventory_version: crypto.randomUUID(),
    changed_item_ids: Array.isArray(changedIds) && changedIds.length > 0 ? changedIds : null,
  };

  const { error } = await supabase
    .from("metadata")
    .update(payload)
    .eq("id", "inventory");

  if (error) {
    console.warn("⚠️ Failed to update inventory version:", error.message);
  } else {
    console.log("🔁 Inventory version updated", payload);
  }
}


//function to listen to changes in cache version
function setupInventoryRealtimeListener() {
  const channel = supabase
    .channel("inventory_version")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "metadata" },
      payload => {
        console.log("🔔 Realtime: inventory version changed!", payload);

        const changedIds = payload.new?.changed_item_ids;

        if (Array.isArray(changedIds) && changedIds.length > 0) {
          console.log("🎯 Targeted refresh for items:", changedIds);
          changedIds.forEach(id => refreshItemById(id));
        } else {
          console.log("🔄 No item IDs provided, reloading entire inventory.");
          loadAllItemsWithCache();
        }
      }
    )
    .subscribe();

  console.log("✅ Realtime listener for inventory version initialized:", channel);
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

// 🔸 Helper: Create a category option DOM element
function setManualSaleStatus(message = "", type = "info") {
  const el = document.getElementById("manual-sale-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
}

function parseManualSaleMoney(value) {
  const number = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function getManualSaleItemPhotoPath(item) {
  return (Array.isArray(item?.photoPaths) ? item.photoPaths : Array.isArray(item?.photos) ? item.photos : [])[0] || "";
}

function resetManualEbaySale() {
  manualEbaySaleState.item = null;
  manualEbaySaleState.stockRows = [];
  manualEbaySaleState.selectedStockRow = null;
  ["manual-sale-item-scan", "manual-sale-location-scan", "manual-sale-order-id", "manual-sale-sold-price", "manual-sale-payout", "manual-sale-notes", "manual-sale-password"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const qty = document.getElementById("manual-sale-quantity");
  if (qty) qty.value = "1";
  document.getElementById("manual-sale-item-results")?.replaceChildren();
  document.getElementById("manual-sale-location-results")?.replaceChildren();
  renderManualSaleSummary();
  setManualSaleStatus("");
}

function openManualEbaySaleModal() {
  resetManualEbaySale();
  document.getElementById("manual-ebay-sale-modal")?.classList.remove("hidden");
  document.body.classList.add("modal-open");
  setTimeout(() => document.getElementById("manual-sale-item-scan")?.focus(), 80);
}

function closeManualEbaySaleModal() {
  document.getElementById("manual-ebay-sale-modal")?.classList.add("hidden");
  document.body.classList.remove("modal-open");
  resetManualEbaySale();
}

function renderManualSaleSummary() {
  const summary = document.getElementById("manual-sale-selection-summary");
  if (!summary) return;
  const item = manualEbaySaleState.item;
  const row = manualEbaySaleState.selectedStockRow;
  if (!item) {
    summary.textContent = "No item selected yet.";
    return;
  }
  summary.innerHTML = `
    <strong>${escapeStockHtml(item.title || "Untitled item")}</strong>
    <div class="manual-sale-summary-grid">
      <span><small>Barcode</small>${escapeStockHtml(item.barcode || "-")}</span>
      <span><small>Retail</small>${formatStockMoney(item.sale_price)}</span>
      <span><small>Source</small>${row ? escapeStockHtml(row.locationLabel) : "Choose tray/location"}</span>
      <span><small>Available</small>${row ? Number(row.quantity || 0).toLocaleString() : "-"}</span>
    </div>
  `;
}

function renderManualSaleItemResults(items, message = "No matching items.") {
  const container = document.getElementById("manual-sale-item-results");
  if (!container) return;
  container.replaceChildren();
  if (!items.length) {
    container.innerHTML = `<p>${escapeStockHtml(message)}</p>`;
    return;
  }
  items.slice(0, 10).forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "manual-sale-result-btn";
    btn.innerHTML = `<strong>${escapeStockHtml(item.title || "Untitled item")}</strong><span>${escapeStockHtml(item.barcode || "No barcode")} - ${formatStockMoney(item.sale_price)}</span>`;
    btn.addEventListener("click", () => selectManualSaleItem(item));
    container.appendChild(btn);
  });
}

function renderManualSaleLocationResults(rows, message = "No stock locations found for this item.") {
  const container = document.getElementById("manual-sale-location-results");
  if (!container) return;
  container.replaceChildren();
  if (!rows.length) {
    container.innerHTML = `<p>${escapeStockHtml(message)}</p>`;
    return;
  }
  rows.forEach((row) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `manual-sale-result-btn ${manualEbaySaleState.selectedStockRow?.id === row.id ? "is-selected" : ""}`;
    btn.innerHTML = `<strong>${escapeStockHtml(row.locationLabel)}</strong><span>${Number(row.quantity || 0).toLocaleString()} available${row.location_code ? ` - ${escapeStockHtml(row.location_code)}` : ""}</span>`;
    btn.addEventListener("click", () => selectManualSaleStockRow(row));
    container.appendChild(btn);
  });
}

function findManualSaleItems(term) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return [];
  const exact = allItems.filter((item) => String(item.barcode || "").trim().toLowerCase() === q || String(item.id || "").toLowerCase() === q);
  if (exact.length) return exact;
  return allItems.filter((item) =>
    String(item.barcode || "").toLowerCase().includes(q) ||
    String(item.title || "").toLowerCase().includes(q) ||
    String(item.description || "").toLowerCase().includes(q)
  );
}

async function searchManualSaleItem() {
  const term = document.getElementById("manual-sale-item-scan")?.value || "";
  const matches = findManualSaleItems(term);
  if (matches.length === 1) {
    await selectManualSaleItem(matches[0]);
  } else {
    renderManualSaleItemResults(matches, "Scan an item label or type the title/barcode.");
    setManualSaleStatus(matches.length ? `${matches.length} item match(es). Choose one.` : "No item found.", matches.length ? "info" : "error");
  }
}

async function selectManualSaleItem(item) {
  manualEbaySaleState.item = item;
  manualEbaySaleState.selectedStockRow = null;
  document.getElementById("manual-sale-item-scan").value = item.barcode || item.title || "";
  document.getElementById("manual-sale-sold-price").value = Number(item.sale_price || 0).toFixed(2);
  renderManualSaleItemResults([item]);
  renderManualSaleSummary();
  await loadManualSaleStockRows(item.id);
}

function normalizeManualSaleStockRow(row) {
  const loc = row.location || {};
  const status = loc.is_tray ? (TRAY_STATUS_LABELS[loc.tray_status] || "Tray") : "Location";
  const locationLabel = loc.is_tray ? `${loc.location_name || "Unnamed tray"} (${status})` : (loc.location_name || "Unnamed location");
  return { ...row, location_id: row.location_id || loc.id, location_name: loc.location_name || "", location_code: loc.location_code || "", is_tray: Boolean(loc.is_tray), tray_status: loc.tray_status || "", locationLabel };
}

async function loadManualSaleStockRows(itemId) {
  setManualSaleStatus("Loading available trays and locations...");
  const { data, error } = await supabase
    .from("item_stock_locations")
    .select(`id, item_id, location_id, quantity, location:location_id (id, location_name, location_code, is_tray, tray_status, tray_current_store_id, store_id)`)
    .eq("item_id", itemId)
    .gt("quantity", 0);
  if (error) {
    console.error("Manual eBay sale location load failed:", error);
    manualEbaySaleState.stockRows = [];
    renderManualSaleLocationResults([], "Could not load source locations.");
    setManualSaleStatus(error.message || "Could not load source locations.", "error");
    return;
  }
  manualEbaySaleState.stockRows = (data || []).map(normalizeManualSaleStockRow);
  if (manualEbaySaleState.stockRows.length === 1) selectManualSaleStockRow(manualEbaySaleState.stockRows[0]);
  else {
    renderManualSaleLocationResults(manualEbaySaleState.stockRows);
    setManualSaleStatus(manualEbaySaleState.stockRows.length ? "Choose or scan the source tray/location." : "No available stock found.", manualEbaySaleState.stockRows.length ? "info" : "error");
  }
}

function selectManualSaleStockRow(row) {
  manualEbaySaleState.selectedStockRow = row;
  const locationInput = document.getElementById("manual-sale-location-scan");
  if (locationInput) locationInput.value = row.location_code || row.location_name || row.locationLabel;
  const qtyInput = document.getElementById("manual-sale-quantity");
  if (qtyInput) qtyInput.max = String(Math.max(1, Number(row.quantity || 1)));
  renderManualSaleLocationResults(manualEbaySaleState.stockRows);
  renderManualSaleSummary();
  setManualSaleStatus("Source selected. Enter order details and sign.");
}

async function searchManualSaleLocation() {
  const term = String(document.getElementById("manual-sale-location-scan")?.value || "").trim().toLowerCase();
  if (!term) return setManualSaleStatus("Scan or type a tray/location label.", "error");
  if (manualEbaySaleState.item) {
    const matches = manualEbaySaleState.stockRows.filter((row) =>
      String(row.id || "").toLowerCase() === term ||
      String(row.location_id || "").toLowerCase() === term ||
      String(row.location_code || "").toLowerCase() === term ||
      String(row.location_name || "").toLowerCase().includes(term) ||
      String(row.locationLabel || "").toLowerCase().includes(term)
    );
    if (matches.length === 1) selectManualSaleStockRow(matches[0]);
    else {
      renderManualSaleLocationResults(matches, "That tray/location does not currently hold this item.");
      setManualSaleStatus(matches.length ? `${matches.length} source match(es). Choose one.` : "No matching source for this item.", matches.length ? "info" : "error");
    }
    return;
  }
  setManualSaleStatus("Looking up items in that tray/location...");
  const { data: locations, error: locError } = await supabase.from("locations").select("id, location_name, location_code").limit(1000);
  if (locError) return setManualSaleStatus(locError.message || "Could not search locations.", "error");
  const matches = (locations || []).filter((loc) =>
    String(loc.id || "").toLowerCase() === term ||
    String(loc.location_code || "").toLowerCase() === term ||
    String(loc.location_name || "").toLowerCase().includes(term)
  );
  if (!matches.length) return setManualSaleStatus("No matching tray/location found.", "error");
  const { data: stockRows, error: stockError } = await supabase
    .from("item_stock_locations")
    .select("item_id, quantity, location_id")
    .in("location_id", matches.map((loc) => loc.id))
    .gt("quantity", 0);
  if (stockError) return setManualSaleStatus(stockError.message || "Could not load stock in that location.", "error");
  const itemIds = new Set((stockRows || []).map((row) => row.item_id));
  const items = allItems.filter((item) => itemIds.has(item.id));
  renderManualSaleItemResults(items, "No active items found in that tray/location.");
  setManualSaleStatus(items.length ? `${items.length} item type(s) found in that tray/location.` : "No active stock in that tray/location.", items.length ? "info" : "error");
}

async function verifyManualSalePassword(password) {
  const user = currentUser || (await supabase.auth.getUser()).data.user;
  if (!user?.email || !password) return false;
  const { error } = await supabase.auth.signInWithPassword({ email: user.email, password });
  return !error;
}

async function finalizeManualEbaySale() {
  if (manualEbaySaleState.busy) return;
  const item = manualEbaySaleState.item;
  const row = manualEbaySaleState.selectedStockRow;
  const orderId = String(document.getElementById("manual-sale-order-id")?.value || "").trim();
  const qty = Math.max(1, parseInt(document.getElementById("manual-sale-quantity")?.value || "1", 10) || 1);
  const soldPrice = parseManualSaleMoney(document.getElementById("manual-sale-sold-price")?.value);
  const payoutRaw = document.getElementById("manual-sale-payout")?.value;
  const payout = payoutRaw ? parseManualSaleMoney(payoutRaw) : soldPrice * qty;
  const password = document.getElementById("manual-sale-password")?.value || "";
  const notes = String(document.getElementById("manual-sale-notes")?.value || "").trim();
  if (!item) return setManualSaleStatus("Choose the sold item first.", "error");
  if (!row) return setManualSaleStatus("Choose the tray/location the item is shipping from.", "error");
  if (!orderId) return setManualSaleStatus("Enter the eBay order ID.", "error");
  if (!soldPrice) return setManualSaleStatus("Enter the sold price.", "error");
  if (!password) return setManualSaleStatus("Enter your password to sign this sale.", "error");
  if (qty > Number(row.quantity || 0)) return setManualSaleStatus(`Only ${row.quantity} available in that source.`, "error");
  manualEbaySaleState.busy = true;
  document.getElementById("finalize-manual-ebay-sale").disabled = true;
  showLoading();
  setManualSaleStatus("Signing and recording sale...");
  try {
    const valid = await verifyManualSalePassword(password);
    if (!valid) throw new Error("Incorrect password. Please try again.");
    const { data: existingSale, error: existingError } = await supabase.from("sales").select("id").eq("platform", "ebay").eq("external_sales_id", orderId).maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existingSale?.id) throw new Error("This eBay order ID was already checked out.");
    const { data: latestRow, error: latestError } = await supabase.from("item_stock_locations").select("quantity, location_id").eq("id", row.id).single();
    if (latestError) throw new Error(latestError.message);
    if (Number(latestRow.quantity || 0) < qty) throw new Error(`Only ${latestRow.quantity || 0} available at this source now.`);
    const user = currentUser || (await supabase.auth.getUser()).data.user;
    const lineSubtotal = soldPrice * qty;
    const platformFeeAmount = Math.max(0, lineSubtotal - payout);
    const platformFeePercent = lineSubtotal > 0 ? (platformFeeAmount / lineSubtotal) * 100 : 0;
    const remainingAfterSale = Number(latestRow.quantity || 0) - qty;
    const photoPath = getManualSaleItemPhotoPath(item);
    const cartSnapshot = [{ item_id: item.id, title: item.title, barcode: item.barcode || null, quantity: qty, sale_price: soldPrice, payout, selected_location_id: row.id, physical_location_id: latestRow.location_id || row.location_id, location_label: row.locationLabel, photo_path: photoPath }];
    const { error: auditError } = await supabase.from("sales_audit").insert({
      external_sales_id: orderId, subtotal: lineSubtotal, credits_applied: 0, owes_after_credit: lineSubtotal, per_item_discount: 0, general_discount: 0, effective_discount_pct: 0, owes_store: lineSubtotal, platform_fee_amount: platformFeeAmount, platform_fee_percent: platformFeePercent, profit_amount: payout, platform: "ebay", cart_snapshot: cartSnapshot, flagged: false, notes: notes || "Manual eBay sale checkout", verified_method: "password", verified_at: new Date().toISOString(), created_at: new Date().toISOString(), email: user?.email || null, user_id: user?.id || null, credits_breakdown: []
    });
    if (auditError) throw new Error(`Failed audit log: ${auditError.message}`);
    const { data: saleData, error: saleError } = await supabase.from("sales").insert({
      external_sales_id: orderId, user_id: user?.id || null, email: user?.email || null, platform: "ebay", subtotal: lineSubtotal, credits_applied: 0, total_discount: 0, final_amount: lineSubtotal, platform_fee_amount: platformFeeAmount, platform_fee_percent: platformFeePercent, profit_amount: payout, flagged: false, verified_method: "password", verified_at: new Date().toISOString(), created_at: new Date().toISOString()
    }).select("id").single();
    if (saleError) throw new Error(`Failed to record sale: ${saleError.message}`);
    const { data: saleItemData, error: saleItemError } = await supabase.from("sale_items").insert({
      sale_id: saleData.id, item_id: item.id, title: item.title || "Untitled item", quantity: qty, sale_price: soldPrice, discount_percent: 0, discount_amount: 0, final_price: lineSubtotal, remaining_stock_qty: remainingAfterSale, location_id: latestRow.location_id || row.location_id, photo_path: photoPath
    }).select("id").single();
    if (saleItemError) throw new Error(`Failed to record sale item: ${saleItemError.message}`);
    for (const category of Array.isArray(item.categories) ? item.categories : []) {
      const { error: categoryError } = await supabase.from("sale_item_categories").insert({ sale_item_id: saleItemData.id, category });
      if (categoryError) throw new Error(`Failed to record category "${category}": ${categoryError.message}`);
    }
    const { error: txError } = await supabase.from("stock_transactions").insert({
      item_id: item.id, location_id: latestRow.location_id || row.location_id, quantity: -qty, action_type: "checkout", confirmed_at: new Date().toISOString(), user_id: user?.id || null, email: user?.email || null, notes: `Manual eBay sale, Order ID: ${orderId}${notes ? ` - ${notes}` : ""}`, method: "manual_ebay_sale"
    });
    if (txError) throw new Error(`Failed transaction log: ${txError.message}`);
    const { error: rpcError } = await supabase.rpc("subtract_quantity", { loc_id: row.id, delta: qty });
    if (rpcError) throw new Error(`Failed stock update: ${rpcError.message}`);
    await bumpInventoryVersion([item.id]);
    await refreshItemById(item.id);
    showToast("Manual eBay sale finalized and stock removed.");
    closeManualEbaySaleModal();
  } catch (error) {
    console.error("Manual eBay sale failed:", error);
    setManualSaleStatus(error.message || "Could not finalize eBay sale.", "error");
  } finally {
    manualEbaySaleState.busy = false;
    document.getElementById("finalize-manual-ebay-sale").disabled = false;
    hideLoading();
  }
}

function setupManualEbaySale() {
  document.getElementById("manual-ebay-sale-btn")?.addEventListener("click", openManualEbaySaleModal);
  document.getElementById("close-manual-ebay-sale")?.addEventListener("click", closeManualEbaySaleModal);
  document.getElementById("cancel-manual-ebay-sale")?.addEventListener("click", closeManualEbaySaleModal);
  document.getElementById("manual-sale-find-item")?.addEventListener("click", searchManualSaleItem);
  document.getElementById("manual-sale-find-location")?.addEventListener("click", searchManualSaleLocation);
  document.getElementById("finalize-manual-ebay-sale")?.addEventListener("click", finalizeManualEbaySale);
  document.getElementById("manual-sale-item-scan")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchManualSaleItem(); } });
  document.getElementById("manual-sale-location-scan")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchManualSaleLocation(); } });
  document.getElementById("manual-sale-password")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); finalizeManualEbaySale(); } });
}

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

/**help to make toolbar visible */
function setBulkToolbarVisibility(visible) {
  const toolbar = document.getElementById("bulk-toolbar");
  if (!toolbar) return;

  toolbar.classList.toggle("show", visible);
  toolbar.classList.toggle("hide", !visible);
}

// 🔧 Utility: Setup toggle behavior for any button and target element
// ✅ Parameters:
//   - toggleId: ID of the button that will trigger the toggle
//   - targetId: ID of the element to show/hide
//   - showLabel: (Optional) Text to show when visible
//   - hideLabel: (Optional) Text to show when hidden
function setupToggleBehavior(toggleId, targetId, showLabel = "❌ Hide", hideLabel = "🔍 Show") {
  const toggleBtn = document.getElementById(toggleId);
  const target = document.getElementById(targetId);

  if (!toggleBtn || !target) {
    console.warn("setupToggleBehavior: Invalid IDs provided.");
    return;
  }

  // Get the span inside the button where the label text goes
  const labelSpan = toggleBtn.querySelector("span.label");

  toggleBtn.addEventListener("click", () => {
    const isShown = target.classList.toggle("show");
  
    if (labelSpan) {
      labelSpan.textContent = isShown ? showLabel : hideLabel;
    }
  
    // 🌀 Animate the icon
    const icon = toggleBtn.querySelector("svg.icon");
    if (icon) {
      icon.classList.add("spin");
      setTimeout(() => icon.classList.remove("spin"), 600); // Remove after animation ends
    }
  
    if (window.lucide) {
      window.lucide.createIcons();
    }
  });
  
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

// 🔧 Utility:open the export modal
function setupExportModal() {
  const exportBtn = document.getElementById("bulk-export"); // This already exists
  const modal = document.getElementById("export-modal");
  const closeBtn = document.getElementById("close-export-modal");

  if (!exportBtn || !modal || !closeBtn) return;

  exportBtn.addEventListener("click", () => {
    if (!canViewSensitiveStockData()) {
      showToast("Only admins can export stock data.");
      return;
    }
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
  });

  closeBtn.addEventListener("click", () => {
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");
    resetEbayExportProgress();
  });

  // Close modal if user clicks outside modal content
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
      document.body.classList.remove("modal-open");
      resetEbayExportProgress();
    }
  });
}

function updateEbayExportProgress({
  title = "Preparing eBay export",
  detail = "",
  processed = 0,
  total = 0,
  percent = 0,
  visible = true
} = {}) {
  const panel = document.getElementById("ebay-export-progress");
  const titleEl = document.getElementById("ebay-export-progress-title");
  const countEl = document.getElementById("ebay-export-progress-count");
  const barEl = document.getElementById("ebay-export-progress-bar");
  const detailEl = document.getElementById("ebay-export-progress-detail");

  if (!panel) return;

  panel.classList.toggle("hidden", !visible);
  if (titleEl) titleEl.textContent = title;
  if (countEl) countEl.textContent = total ? `${processed} of ${total}` : "";
  if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (detailEl) detailEl.textContent = detail;
}

function resetEbayExportProgress() {
  updateEbayExportProgress({ visible: false, percent: 0 });
}

//ebuy export function
function setupEbayExportButton() {
  const ebayBtn = document.getElementById("export-ebay-btn");
  const modal = document.getElementById("export-modal");

  if (!ebayBtn || !modal) return;

  ebayBtn.addEventListener("click", async () => {
    const itemsToExport = allItems.filter(item => selectedItems.has(item.id));
    const exportType = document.querySelector('input[name="ebay-export-type"]:checked')?.value || "pendant";
    const exportProfile = window.EBAY_EXPORT_PROFILES?.[exportType];

    if (!itemsToExport.length) {
      showToast("🛑 No items selected for export.");
      updateEbayExportProgress({
        title: "Nothing to export",
        detail: "Select at least one item before starting an eBay export.",
        visible: true
      });
      return;
    }

    ebayBtn.disabled = true;
    updateEbayExportProgress({
      title: `Exporting ${itemsToExport.length} ${exportProfile?.label || "eBay"} item${itemsToExport.length === 1 ? "" : "s"}`,
      detail: "Starting export...",
      processed: 0,
      total: itemsToExport.length,
      percent: 3,
      visible: true
    });

    try {
      showToast("⏳ Generating eBay export...");
      await window.exportToEbayXLSX(itemsToExport, {
        exportType,
        onProgress: updateEbayExportProgress
      });
      updateEbayExportProgress({
        title: "eBay export ready",
        detail: `Finished ${itemsToExport.length} selected item${itemsToExport.length === 1 ? "" : "s"}. Your CSV download should begin now.`,
        processed: itemsToExport.length,
        total: itemsToExport.length,
        percent: 100,
        visible: true
      });
      showToast("✅ Your eBay CSV file is ready.");
      setTimeout(() => {
        modal.classList.add("hidden");
        document.body.classList.remove("modal-open");
        resetEbayExportProgress();
      }, 1400);
    } catch (err) {
      console.error("Export error:", err);
      updateEbayExportProgress({
        title: "Export failed",
        detail: err?.message || "Something went wrong while generating the eBay export.",
        processed: 0,
        total: itemsToExport.length,
        percent: 100,
        visible: true
      });
      showToast("❌ Failed to generate export.");
    } finally {
      ebayBtn.disabled = false;
    }
  });
}

//#endregion

/* ================= User Interface Rendering Functions ============= */

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
  await loadAllItemsWithCache(); // populates allItems globally
  const filtered = getFilteredItems(allItems);
  applySortAndRender(filtered);
  updateFilterChips(getActiveFilters());
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
    console.log("🧪 Save button clicked");

    const updated = Array.from(new Set([...(current.categories || []), ...selected]));
    await bumpInventoryVersion();
    await updateItemCategories(itemId, updated);
    dropdown.remove();
    activeDropdown = null;

    await refreshItemById(itemId); // ✅ Only re-renders that card

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


// ✅ Main entry point: Initializes app on DOM ready
// ✅ Applies modular functions, loads user data, sets up all UI handlers
document.addEventListener("DOMContentLoaded", async () => {
  // Step 1: Authenticate and load user favorites
  currentUser = (await supabase.auth.getUser()).data.user;
  if (currentUser) {
    await loadStockAccessForCurrentUser();
    const { data: favs } = await supabase
      .from("favorites")
      .select("item_id")
      .eq("user_id", currentUser.id);
    userFavorites = new Set(favs.map(f => f.item_id));
  }

  // Step 2: Fetch items from Supabase and store globally
  await loadAllItemsWithCache();
  await checkoutModule.loadCreditTiers();
  setupInventoryRealtimeListener();
  await checkoutModule.loadCartFromStorage();  // handles image signing + UI

  //#region step 3 create all the necessary drop downs for the system
    //dropdown for filter by categories
    populateDropdowns({ 
      data: allItems, //data from where categories will be extracted
      column: "categories", //the name of the column from where the categories will be extracted
      optionsContainerClass: "category-dropdown-container", //class of the div container where all the stuff will be
      toggleId: "category-dropdown-toggle", //id of the button that will make the menu pop up (html)
      menuId: "category-dropdown-menu", //id of the block that will show when toggle is in show (html)
      optionClass: "dropdown-option", //class that will be given to each of the dropdown buttons (injected)
      searchId: "category-search", //id of the search bar (injected by html)
      placeholder: "Search categories...", //text that will show up in the search bar
      onClick: setAsSelected
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
      dataAttribute: "qr",
      onClick: setAsSelected
    });

    //dropdown for bulk effect of adding categories
    populateDropdowns({
      data: allItems,                   // your full dataset
      menuId: "bulk-category-menu",          // ID of the dropdown container
      toggleId: "bulk-category-toggle",      // ID of the toggle button (if applicable)
      optionsContainerClass: "bulk-category-container",
      column: "categories",             // column to extract unique values from
      dataAttribute: "catbulk", 
      optionClass: "dropdown-option",
      searchId: "category-search", //id of the search bar (injected by html)
      placeholder: "Search categories...", //text that will show up in the search bar          
      onClick: (value, isNew) => {
        addValueToSelectedItems({
          table: "item_types",
          column: "categories",
          value,
          selectedIds: selectedItems,
          allItems
        }).then(() => {
          refreshUIAfterCategoryChange(); // update DOM + dropdown
        });
      }
    });

    //dropdown for location selection
populateDropdowns({
  data: allItems,
  column: "stock_locations",
  menuId: "location-filter-menu",
  toggleId: "location-filter-toggle",
  optionsContainerClass: "dropdown-options-location",
  dataAttribute: "location",
  optionClass: "dropdown-option",
  searchId: null,
  placeholder: "Search locations...",
  onClick: setAsSelected,
});

    

  //#endregion

  //#region step 4 application of filter and chips in cards
    //verify whether the url is not indicating you filters must be apply, load them to form
    applyFiltersFromURL();
   // syncHiddenInputsWithDropdowns();
    const form = document.getElementById("filter-form");
    const formData = new FormData(form);
    const entries = Object.fromEntries(formData.entries());
    console.log("🧾 Form Values after the apply filter from url:", formData.getAll("categories"))

    //get the filter from the from populated, render them, this include chips too
    const filters = getActiveFilters();
    console.log("🎯 Active Filters Snapshot:");
    console.table(filters);


    //get only the items that meet filtering critera
    const filtered = getFilteredItems(allItems);
    
    applySortAndRender(filtered);
    updateFilterChips(filters);
  //#endregion

  //#region step 5 set up the event listernes 

    
    
    //event listeners for the form, pagination control, updating url, etc
    setupDynamicFilters("filter-form", ["sort-select", "cards-per-page"]);

    //envent listener for the show or hide filter in main control
    setupToggleBehavior("toggle-filters", "filter-section", "Hide Filters", "Show Filters");
    
    //set up button to clears all items form (button and everything) the filter form and rerender everything
    setupClearFilters("clear-filters", "filter-form");

    //sets up the event listernest for the sort dropdown
    setupCustomDropdown({
      toggleId: "sortDropdownToggle",
      menuId: "sortDropdownMenu",
      containerSelector: ".custom-sort-dropdown",
      selectId: "sort-select"
    });

    //event listener for card functions
    setupCardEventListeners();
    setupStockMediaListeners();
    editCardModule.setupEditCardListeners();

    //event listener to switch filter tabs and the match all button
    setupFilterPanelUI();
    
    //event listener for the bulk actions, except dropdown of course
    setupBulkToolbarListeners();

    //event listener for scrolling 
    window.addEventListener("scroll", () => {
      const topBar = document.querySelector(".top-controls");
      topBar.classList.toggle("sticky-active", window.scrollY > 10);
    });
    

    //event listener for the home button
    document.getElementById("toggle-controller").addEventListener("click", () => {
      const header = document.querySelector(".container");
      const toggleBtn = document.getElementById("toggle-controller");
    
      // Toggle panel visibility
      header.classList.toggle("collapsed");
    
      // Trigger haptic pulse animation
      toggleBtn.classList.add("haptic");
      setTimeout(() => toggleBtn.classList.remove("haptic"), 1);
    });

    //event listerner for the export modal and logic
    setupExportModal();
    setupManualEbaySale();
    setupEbayExportButton(); // <— this must run


    //event listerner for the card dropdown
    setupCardChipDropdownDelegated()

    //for the dynamo label
    document.addEventListener("click", async (e) => {
  const link = e.target.closest(".dymo-link");
  if (!link) return;

  e.preventDefault();
  let fullPath = link.dataset.path;
  if (!fullPath.startsWith("labels/")) {
    fullPath = `labels/${fullPath}`;
  }

  try {
    const { data, error } = await supabase
      .storage
      .from("dymo-labels")
      .createSignedUrl(fullPath, 60 * 60 * 24 * 365);

    if (error || !data?.signedUrl) {
      console.error("❌ Error generating signed URL:", error?.message);
      alert("Unable to open DYMO label.");
      return;
    }

    window.open(data.signedUrl, "_blank");
  } catch (err) {
    console.error("❌ Exception generating DYMO URL:", err);
    alert("Unexpected error opening label.");
  }
    });

    //#region events listeners for the checkout module
      //event listener fo the toggle button
      checkoutModule.setupCheckoutToggleButton();

      //event lister to the checkout cart 
      checkoutModule.setupCartPanelListeners();

      //lister for the tabs 
      await checkoutModule.loadCartFromStorage();
      checkoutModule.setupCartTabs();
      checkoutModule.setupCreditTierListeners();
      checkoutModule.updateCreditInputsFromCartState(); // 🔥 Then update UI with correct credits
      checkoutModule.updateCreditValue();               // 🔥 Ensure summary is calculated on load
      checkoutModule.setupCheckoutConfirmationModal();

      //event listener for the modal checkout after items are added to the cart
      checkoutModule.setupCheckoutModalListeners();
    //#endregion
 
    //#region event listener for transfer stock module
      transferModule.setupListeners();

    //#endregion 
  //#endregion

  //step 6 ensure there is function to update the toolbar
  updateBulkToolbar();

});


// ✅ New fixer function
/*
window.fixPhotoFilenames = async function () {
  console.log("🔎 Starting photo filename fixer...");

  // 1) Fetch all items with their IDs and photo arrays
  const { data: items, error } = await supabase
    .from("item_types")
    .select("id, photos");

  if (error) {
    console.error("❌ Failed to fetch item_types:", error.message);
    return;
  }

  let processedCount = 0;
  let fixedCount = 0;

  for (const item of items) {
    if (!item.photos || !Array.isArray(item.photos)) continue;

    let updatedPhotos = [...item.photos];
    let itemChanged = false;

    for (let i = 0; i < item.photos.length; i++) {
      const oldPath = item.photos[i];
      const filename = oldPath.split("/").pop();

      if (filename.includes(" ")) {
        console.log(`🚨 Found space in photo: ${oldPath}`);

        const cleanFilename = filename.replace(/\s+/g, "_");
        const newPath = oldPath.replace(filename, cleanFilename);

        try {
          // 2) Download the existing file
          const { data: fileData, error: downloadError } = await supabase
            .storage
            .from("photos")
            .download(oldPath);

          if (downloadError || !fileData) {
            console.error(`❌ Failed to download ${oldPath}:`, downloadError?.message);
            continue;
          }

          // 3) Upload the sanitized file
          const { error: uploadError } = await supabase
            .storage
            .from("photos")
            .upload(newPath, fileData, { upsert: true });

          if (uploadError) {
            console.error(`❌ Failed to upload ${newPath}:`, uploadError.message);
            continue;
          }

          // 4) Update the photos array locally
          updatedPhotos[i] = newPath;

          // 5) Delete the old file
          const { error: deleteError } = await supabase
            .storage
            .from("photos")
            .remove([oldPath]);

          if (deleteError) {
            console.warn(`⚠️ Could not delete old file ${oldPath}:`, deleteError.message);
            // Not fatal: we can clean later manually if needed.
          }

          console.log(`✅ Fixed ${oldPath} → ${newPath}`);
          itemChanged = true;
          fixedCount++;

        } catch (e) {
          console.error(`❌ Unexpected error processing ${oldPath}:`, e);
          continue;
        }
      }
    }

    // 6) If we made changes to this item, update it in DB
    if (itemChanged) {
      const { error: updateError } = await supabase
        .from("item_types")
        .update({ photos: updatedPhotos })
        .eq("id", item.id);

      if (updateError) {
        console.error(`❌ Failed to update item ${item.id}:`, updateError.message);
        continue;
      }

      console.log(`🔄 Updated item ID ${item.id} with cleaned photo paths.`);

      // ✅ Update the inventory version with the changed item ID
      await bumpInventoryVersion([item.id]);
    }

    processedCount++;
  }

  console.log(`🎉 Finished fixing photos. Processed ${processedCount} items. Fixed ${fixedCount} files.`);
};
*/

//macros that i need
/**check which barcodes are already uploaded
Sub CheckBarcodesAuto()
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Sheets(1) ' You can change this to your actual sheet if needed

    Dim lastBarcodeRow As Long
    Dim lastCheckRow As Long
    Dim barcodes As Range
    Dim codesToCheck As Range
    Dim cell As Range

    ' Auto-detect last row in column A (main barcodes)
    lastBarcodeRow = ws.Cells(ws.Rows.Count, "B").End(xlUp).Row
    Set barcodes = ws.Range("B2:B" & lastBarcodeRow)

    ' Auto-detect last row in column D (codes to check)
    lastCheckRow = ws.Cells(ws.Rows.Count, "CM").End(xlUp).Row
    Set codesToCheck = ws.Range("CM2:CM" & lastCheckRow)

    ' Loop through each code to check
    For Each cell In codesToCheck
        If Application.WorksheetFunction.CountIf(barcodes, cell.Value) > 0 Then
            cell.Offset(0, 1).Value = "? Found"
        Else
            cell.Offset(0, 1).Value = "? Not Found"
        End If
    Next cell
End Sub



Sub DeleteMatchingBarcodes()
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Sheets(1) ' Adjust to your target sheet if needed

    Dim lastMainRow As Long
    Dim lastDeleteRow As Long
    Dim barcodesToDelete As Collection
    Dim i As Long
    Dim cell As Range

    ' Get last rows
    lastMainRow = ws.Cells(ws.Rows.Count, "B").End(xlUp).Row
    lastDeleteRow = ws.Cells(ws.Rows.Count, "CO").End(xlUp).Row

    ' Load all barcodes to delete into a collection for fast lookup
    Set barcodesToDelete = New Collection
    On Error Resume Next ' Ignore errors for duplicates
    For Each cell In ws.Range("CO2:CO" & lastDeleteRow)
        If Trim(cell.Value) <> "" Then
            barcodesToDelete.Add cell.Value, CStr(cell.Value)
        End If
    Next cell
    On Error GoTo 0

    ' Loop through main list from bottom to top
    For i = lastMainRow To 2 Step -1
        Dim currentCode As String
        currentCode = Trim(ws.Cells(i, "B").Value)

        If currentCode <> "" Then
            On Error Resume Next
            Dim test As Variant
            test = barcodesToDelete(CStr(currentCode))
            If Err.Number = 0 Then
                ws.Rows(i).Delete
            End If
            Err.Clear
            On Error GoTo 0
        End If
    Next i

    MsgBox "? Matching barcodes deleted.", vbInformation
End Sub


 */
