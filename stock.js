// 🔹 Global App State
let currentPage = 1;                    // Current page number or pagination
let itemsPerPage = 12;                 // Number of items per page
let allItems = [];                     // Holds all fetched stock items
let userFavorites = new Set();         // Set of favorite item IDs for the current user
let currentUser = null;                // Holds authenticated user info
let selectedItems = new Set();         // Tracks currently selected items for bulk actions
let showOnlyFavorites = false;         // Flag to toggle "Show Only Favorites"
let activeDropdown = null;
let failedAttempts = 0;            // 🚫 Track how many wrong passwords
let lockoutUntil = null;           // ⏳ Timestamp until which delete is locked


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
        const stockClass = stock === 0 ? "stock-zero" : ""; /**this is
        assigning a special class stock-zerp=0 for cards that have 0 stock 
        otherwise nothing*/
    
        const categoryChips = (item.categories || []).map(cat => { /**this
            specifies that if item.categories is undefinend, fall back to an 
            empty array []
            -map in this case will loop though each value of the array defined
            by caterogories in the item row */
            const color = getChipColor(cat); /**returns the color class */
            return `
                <div class="category-chip" data-color="${color}" data-cat="${cat}" data-id="${item.id}">
                ${cat}
                <button class="remove-category-btn">&times;</button>
                </div>
            `;
        }).join(""); /**glues all the string into one HTML block that will be in the
        javascrip object called category chips */
    
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
            <div id="cardchip-container-${item.id}" class="custom-dropdown" data-id="${item.id}">
              <button id="cardchip-toggle-${item.id}" type="button" class="dropdown-toggle">
                + Add category
              </button>
              <div id="cardchip-menu-${item.id}" class="dropdown-menu"></div>
            </div>
          </div>
        </div>
        `; /** the add-category-chip has a data-id so when the event listener is triggered
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
        /** the ouput will be something like this,this is what you will inject 
        <div class="carousel" id="carousel-0">
            <button class="carousel-btn left" data-carousel-index="0" data-dir="prev">❮</button>
            <div class="carousel-track">
                <img src="photo1.jpg" class="carousel-photo active" />
                <img src="photo2.jpg" class="carousel-photo" />
                <img src="photo3.jpg" class="carousel-photo" />
            </div>
            <button class="carousel-btn right" data-carousel-index="0" data-dir="next">❯</button>
        </div>
        */
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
      `; /**class set so we can add event listener for bulk operations
      the id will let the ystem know which even was clicked
      if isSelected is true add checked otherwise nothing */
    
      const favoriteBtn = currentUser
        ? `<button class="favorite-btn" data-id="${id}">
             ${isFavorited ? '★' : '☆'}
           </button>`
        : '';
    
      return checkbox + favoriteBtn;
      /**this will be injected as
      <div class="card-float-controls">
          <!-- Checkbox -->
          <input type="checkbox" class="select-checkbox" data-id="123" checked>

          <!-- Favorite Button -->
          <button class="favorite-btn" data-id="123">★</button>
      </div>
       */
  } //neds an event listener 

  //function needed to coordinate html creation for one card
  /** item: individual inventory object with the full row of information
  * index: position of the item in the array
  */
  function renderStockCard(item, index) { 
      const card = document.createElement("div"); /**creates the javascript
      object */
      card.className = "stock-card";
      card.style.position = "relative"; /**This will ensure all children inside
      this cards are positioned related to it */
      card.dataset.itemId = item.id; /** this is going to give to that card 
      object a specific id, which is going to be in the id column (key) of the item
      (row from data array)
      now the good thing is that this can be used by an event listener*/
    
      const isFavorited = currentUser && userFavorites.has(item.id); /**check
      if this caard was selected as favorite by user */
      const isSelected = selectedItems.has(item.id); /** check whether this card
      id exists within the selectedItems list */
      if (isFavorited) card.classList.add("favorited"); /** add these
      classes for rendering purposes if boolean true */
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

  //function needed to create the HTML all the stock cards available
  function renderStockItems(data) {
      const grid = document.getElementById("stock-container"); //select the DOM node where to hold infnormation
      grid.innerHTML = ""; //empty all the contents
  
      const fragment = document.createDocumentFragment(); /**create a document fragment
      it is like a local DOM where you can append all the items you want, and at the end
      you append the whole thing */
  
      data.forEach((item, index) => { /** loop to create one card per item
          and of course you append to the fragment */
          const card = renderStockCard(item, index); //it will hold the html for the whole card
          fragment.appendChild(card); //it will append the whole html to the fragment
      });
  
      grid.appendChild(fragment); //append the fragment which is the local DOM to the live DOM
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
        const id = e.target.dataset.id; // Common data-id used for most card actions

        // ⭐ Toggle favorite status
        if (e.target.matches(".favorite-btn")) {
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
            removeCategory(itemId, cat);                   // update data & UI
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
      });

      // ☑️ Handle selection checkbox toggle (for bulk actions)
      document.addEventListener("change", (e) => {
        if (e.target.matches(".select-checkbox")) {
          const id = e.target.dataset.id;
          const checked = e.target.checked;
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

        categories: [...new Set(
          [...document.querySelectorAll(".dropdown-option.selected[data-cat]")]
            .map(el => el.dataset.cat)
            .filter(Boolean)
        )],

        qr_type: [...document.querySelectorAll('.dropdown-option.selected[data-qr]')]
          .map(el => el.dataset.qr)

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
          (showOnlyFavorites ? userFavorites.has(item.id) : true)
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
      btn.addEventListener("click", () => {
        currentPage = page;
        const filtered = getFilteredItems(allItems);
        applySortAndRender(filtered);
        updateFilterChips(getActiveFilters()); //volver
        //updateURLFromForm(); //volver
      });
      container.appendChild(btn);
    }

    //function to put buttons for the pages
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

    // ☑️ Select All / Deselect All Visible toggle
    const selectAllBtn = document.getElementById("select-all-visible");
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => {
        const cards = document.querySelectorAll(".stock-card"); // Visible cards only
        let allSelected = true;

        cards.forEach(card => {
          const id = card.dataset.itemId;
          if (!selectedItems.has(id)) {
            allSelected = false;
          }
        });

        if (allSelected) {
          // ❌ Deselect all
          cards.forEach(card => {
            const id = card.dataset.itemId;
            const checkbox = card.querySelector(".select-checkbox");
            if (checkbox && checkbox.checked) {
              checkbox.checked = false;
              selectedItems.delete(id);
              card.classList.remove("selected"); // 🧼 remove selected class
            }
          });
          selectAllBtn.innerHTML = `<i data-lucide="check-square" class="icon"></i> Select All Visible`;
        } else {
          // ✅ Select all
          cards.forEach(card => {
            const id = card.dataset.itemId;
            const checkbox = card.querySelector(".select-checkbox");
            if (checkbox && !checkbox.checked) {
              checkbox.checked = true;
              selectedItems.add(id);
              card.classList.add("selected"); // ✅ add selected class
            }
          });
          selectAllBtn.innerHTML = `<i data-lucide="square" class="icon"></i> Deselect All`;

        }
        if (window.lucide) lucide.createIcons(); // ✅ re-render injected icons
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
      selectAllBtn.textContent = "Select All Visible";
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
    
          allItems = await fetchStockItems();
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
    });

    // 📄 Export selected cards to CSV
    document.getElementById("bulk-export")?.addEventListener("click", () => {
      const exportCards = Array.from(document.querySelectorAll(".stock-card"))
        .filter(card => selectedItems.has(card.dataset.itemId));

      if (exportCards.length === 0) return;

      exportCardsToCSV(exportCards); // Export utility function
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
          optionsContainerClass: "dropdown-options-container", // Wraps option list
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
      <input type="text" id="${searchId}" placeholder="${placeholder}">
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
  const items = await fetchStockItems();
  const filtered = getFilteredItems(items);
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
  // Step 1: Authenticate and load user favorites
  currentUser = (await supabase.auth.getUser()).data.user;
  if (currentUser) {
    const { data: favs } = await supabase
      .from("favorites")
      .select("item_id")
      .eq("user_id", currentUser.id);
    userFavorites = new Set(favs.map(f => f.item_id));
  }

  // Step 2: Fetch items from Supabase and store globally
  allItems = await fetchStockItems();

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
    

    //event listerner for the card dropdown
    setupCardChipDropdownDelegated()
    
  //#endregion

  //step 6 ensure there is function to update the toolbar
  updateBulkToolbar();

});

/* to be able to upload functions to run them in the console
window.extractFilterValues = extractFilterValues;
window.getFilteredItems = getFilteredItems;
*/