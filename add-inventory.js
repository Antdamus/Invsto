
let pendingItem = null; // Store the scanned item awaiting confirmation
let currentBatch = {}; 

//#region full logic to what will be done once the item reaches its limit
  //function to turn on and off the autofocus and the input of adding items by barcode
  function updateBarcodeInputStateBasedOnModals() {
    const barcodeInput = document.getElementById("input-to-search-inventory-item");
    const anyModalOpen = Array.from(document.querySelectorAll(".modal"))
      .some(modal => !modal.classList.contains("hidden"));
  
    // 🔒 Disable background scroll when any modal is open
    document.body.classList.toggle("modal-open", anyModalOpen);
  
    // 🔧 Barcode field focus/blur
    barcodeInput.disabled = anyModalOpen;
    if (!anyModalOpen) {
      barcodeInput.focus();
    }
  }
  

  // ✅ Updated to pull from the `locations` table
  async function fetchUniqueLocationNames() {
    const { data, error } = await supabase
      .from("locations")
      .select("location_name")
      .eq("active", true); // optional: only include active locations

    if (error || !data) {
      console.error("❌ Failed to fetch location names from `locations`:", error);
      return [];
    }

    const unique = [...new Set(data.map(row => row.location_name).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b)); // alphabetical
  }

  //function to transform the inputs into selected in case it is needed
  function syncHiddenInputsWithDropdowns() {
    const form = document.getElementById("filter-form");
    if (!form) return; // 🛑 Prevent crashing if filter-form is not present
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
    onClick,  // 🔥 REQUIRED: handler for both new and existing options
    showHTMLInjected = true // 🆕 Optional debug flag
  }) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
  
    const searchHTML = `
      <div class="dropdown-search-container">
        <input type="text" id="${searchId}" class="dropdown-search" placeholder="${placeholder}">
      </div>
    `;
  
    const optionsHTML = `
      <div class="${optionsContainerClass}">
        ${options.map(opt => `
          <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
        `).join("")}
      </div>
    `;
  
    const fullHTML = searchHTML + optionsHTML;
  
    if (showHTMLInjected) {
      console.log("🧪 [renderDropdownOptionsCustom] Injected HTML for", menuId);
      console.log(fullHTML);
      debugger;
    }
  
    menu.innerHTML = fullHTML;
  
    const input = menu.querySelector(`#${searchId}`);
    const container = menu.querySelector(`.${optionsContainerClass}`);
  
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
  
    attachClickHandlers();
  
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
      attachClickHandlers();
    });
  }
  
  //function to populate the dropdown 
  async function populateLocationDropdown() {
    const options = await fetchUniqueLocationNames();
    renderDropdownOptionsCustom({
      menuId: "location-dropdown-list",
      options,
      searchId: "location-dropdown-search", // ✅ you'll add this ID to the search input
      placeholder: "Search or select location...",
      optionClass: "location-option",         // CSS class for styling
      dataAttribute: "location",              // Used for dataset.location
      optionsContainerClass: "location-options-container", // for styling
      onClick: (value, isNew, el) => {
        if (isNew) {
          document.getElementById("location-name").value = value;
          document.getElementById("modal-add-location").classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();
          document.getElementById("location-name").focus();
          return;
        }
      
        document.getElementById("location-dropdown-search").value = value;
        showToast(`📦 Location selected: ${value}`);
      }
    });
  }
  
  //function to coordinate the display of the assign location modal 
  function showAssignLocationModal(batchItem) {
    const modal = document.getElementById("modal-assign-location");
    const searchInput = document.getElementById("location-dropdown-search");
    const scanInput = document.getElementById("input-scan-location-barcode");
    const lastUsedLabel = document.getElementById("last-used-location-name");
  
    // Clear previous states
    searchInput.value = "";
    scanInput.value = "";
    document.getElementById("location-dropdown-list").innerHTML = "";
  
    // Show last used location if any
    const lastLocation = batchItem.lastLocation || "—";
    lastUsedLabel.textContent = lastLocation;
  
    modal.dataset.barcode = batchItem.item.barcode;
    modal.classList.remove("hidden");
    updateBarcodeInputStateBasedOnModals();

    populateLocationDropdown();  // ⬅ Inject dropdown when modal opens

    searchInput.focus();
  }

  //function to coordinate the display of the limit modal
  function showBatchThresholdModal(batchItem) {
    const modal = document.getElementById("modal-batch-threshold-reached");
    const scannedCountDisplay = document.getElementById("scanned-count-display");
    const inputField = document.getElementById("input-manual-count");
    const errorMsg = document.getElementById("manual-count-error-msg");
    const input = document.getElementById("input-to-search-inventory-item");
  
    // 🧠 NEW: populate photo and title in the modal
    const item = batchItem.item;
    const itemPhotoEl = document.getElementById("batch-item-photo");
    const itemTitleEl = document.getElementById("batch-item-title");
  
    itemPhotoEl.src = item.photos?.[0] || "";
    itemPhotoEl.alt = item.title || "Item Photo";
    itemTitleEl.textContent = item.title || "Unnamed Item";
  
    modal.dataset.barcode = item.barcode;
    scannedCountDisplay.textContent = batchItem.count;
    inputField.value = "";
    errorMsg.classList.add("hidden");
    updateBarcodeInputStateBasedOnModals();
  
    modal.classList.remove("hidden");
    updateBarcodeInputStateBasedOnModals();
    inputField.focus();
  }

  
  //listeners
    //manual countverification listener
    function setupManualCountVerificationListeners() {
      const modal = document.getElementById("modal-batch-threshold-reached");
      const confirmBtn = document.getElementById("btn-confirm-manual-count");
      const cancelBtn = document.getElementById("btn-cancel-manual-count");
      const input = document.getElementById("input-manual-count");
      const errorMsg = document.getElementById("manual-count-error-msg");
      const inputScanner = document.getElementById("input-to-search-inventory-item");
    
      confirmBtn.onclick = () => {
        const barcode = modal.dataset.barcode;
        const batchItem = currentBatch[barcode];
        const manualCount = parseInt(input.value.trim(), 10);
    
        if (isNaN(manualCount)) return;
    
        if (manualCount === batchItem.count) {
          showToast("✅ Manual count confirmed. Please assign location.");
          modal.classList.add("hidden");
          errorMsg.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          inputScanner.disabled = false;
          inputScanner.blur();
    
          showAssignLocationModal(batchItem); // 👈 trigger next modal
        } else {
          errorMsg.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();

          const mismatchModal = document.getElementById("modal-manual-count-mismatch");
          mismatchModal.dataset.barcode = barcode;
          modal.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          mismatchModal.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();

        }
      };
    
      cancelBtn.onclick = () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        errorMsg.classList.add("hidden");
        inputScanner.disabled = false;
        inputScanner.focus();
      };
    }
    

    //missmatch in count listener 
    function setupMismatchResetModalListener() {
      const modal = document.getElementById("modal-manual-count-mismatch");
      const okButton = document.getElementById("btn-reset-count-to-zero");
      const scannerInput = document.getElementById("input-to-search-inventory-item");
    
      okButton.onclick = () => {
        const barcode = modal.dataset.barcode;
        if (!barcode || !currentBatch[barcode]) return;
      
        const batchItem = currentBatch[barcode];
        batchItem.count = 0;
      
        // Reset UI counter
        const unitDisplay = batchItem.cardEl.querySelector(".units-scanned");
        if (unitDisplay) {
          unitDisplay.textContent = `Units Scanned: 0`;
        }
      
        // 🔴 Add red glow class
        batchItem.cardEl.classList.add("count-zero-alert");
      
        // Hide the modal and refocus scanner
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        scannerInput.disabled = false;
        scannerInput.focus();
      };
      
    }

    //event listener for assigning the location to item 
    function setupAssignLocationModalListeners() {
      const modal = document.getElementById("modal-assign-location");
      const confirmBtn = document.getElementById("btn-confirm-location-assign");
      const cancelBtn = document.getElementById("btn-cancel-location-assign");
      const searchInput = document.getElementById("location-dropdown-search");
      const scanInput = document.getElementById("input-scan-location-barcode");
      const barcodeInput = document.getElementById("input-to-search-inventory-item");
    
      cancelBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        barcodeInput.disabled = false;
        barcodeInput.focus();
      });
    
      confirmBtn.addEventListener("click", () => {
        const barcode = modal.dataset.barcode;
        const batchItem = currentBatch[barcode];
        const selectedLocation = searchInput.value.trim() || scanInput.value.trim();
    
        if (!selectedLocation) {
          showToast("⚠️ Please select or scan a location.");
          return;
        }
    
        // Store the location name in memory (could be used later)
        batchItem.lastLocation = selectedLocation;
    
        // TODO: You’ll save to `item_stock_locations` later with a proper insert.
    
        showToast(`✅ Assigned to: ${selectedLocation}`);
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        barcodeInput.disabled = false;
        barcodeInput.focus();
      });
    }
    
    //#region 🔧 Location Modal Logic
    function setupLocationModalListeners() {
      const modal = document.getElementById("modal-add-location");
      const form = document.getElementById("form-add-location");
      const cancelBtn = document.getElementById("btn-cancel-location");
    
      const nameInput = document.getElementById("location-name");
      const barcodeInput = document.getElementById("location-barcode");
      const capacityInput = document.getElementById("location-capacity");
      const photoInput = document.getElementById("location-photo");
      const notesInput = document.getElementById("location-notes");
    
      function clearForm() {
        nameInput.value = "";
        barcodeInput.value = "";
        capacityInput.value = "";
        notesInput.value = "";
        photoInput.value = "";
      }
    
      function toggleModal(show = true) {
        if (show) {
          modal.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();
          nameInput.focus();
        } else {
          modal.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          clearForm();
        }
      }
    
      // Show modal externally via:
      // toggleModal(true); (e.g. when "Create +" is clicked)
    
      cancelBtn.addEventListener("click", () => toggleModal(false));
    
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
    
        const location_name = nameInput.value.trim();
        const location_code = barcodeInput.value.trim();
        const max_capacity = capacityInput.value.trim();
        const notes = notesInput.value.trim();
        const photoFile = photoInput.files?.[0] || null;
    
        if (!location_name || !location_code) {
          showToast("⚠️ Name and barcode are required.");
          return;
        }
    
        showToast("Uploading...");
    
        let photo_url = null;
        if (photoFile) {
          const { data, error } = await supabase.storage
            .from("location-assets")
            .upload(`photos/${Date.now()}_${photoFile.name}`, photoFile);
          if (error) {
            showToast("❌ Failed to upload photo.");
            return;
          }
          const { data: urlData } = supabase.storage.from("location-assets").getPublicUrl(data.path);
          photo_url = urlData.publicUrl;
        }
    
        const { error: insertError } = await supabase.from("locations").insert({
          location_name,
          location_code,
          max_capacity: max_capacity ? parseInt(max_capacity) : null,
          notes,
          active: true,
          photo_url
        });
    
        if (insertError) {
          console.error("❌ Error inserting location:", insertError);
          showToast("❌ Failed to save location.");
          return;
        }
    
        showToast("✅ Location saved!");
        toggleModal(false);
        await populateLocationDropdown(); // Refresh dropdown options
      });
    }
    
    

//#endregion

    
  

//#endregion 

//#region Full logic to get an item from supabase and get the barcode
    //show toast function
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

    //function to extract item from supabase if it match barcode item
    async function ExtractItemWithBarcodeFromSupabase(barcode, table = "item_types", column = "barcode", debug = false) {
        try {
            const { data, error } = await supabase
                .from(table)
                .select("*")
                .eq(column, barcode)
                .single();
    
            if (debug) {
                console.log("🔍 [DEBUG] Barcode Query Result:");
                console.log(data);
            }
    
            if (error || !data) {
                if (debug) {
                    console.warn("⚠️ [DEBUG] Item not found or error occurred.", { error });
                }
                return null;
            }
    
            return data;
        } catch (err) {
            console.error("❌ [DEBUG] Unexpected error while querying Supabase:", err);
            showToast("Error contacting database.", "error");
            return null;
        }
    }

    //function to play sound after item is scanned
    function playScanSound() {
      const audio = document.getElementById("scan-sound");
      if (audio) audio.play();
    }
    

    //#region Rendering card item that matched barcode
        //#region buil image carousel
            //Move to next image in carousel for a given card
            function nextSlide({
              index,
              carouselTrackClass = "carousel-track",
              photoActualClass = "carousel-photo"
            }={}) {
                const carousel = document.getElementById(`carousel-${index}`);
                const track = carousel.querySelector(`.${carouselTrackClass}`);
                const images = track.querySelectorAll(`.${photoActualClass}`);
            
                // 🔍 Find currently active image
                const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
                images[currentIndex].classList.remove("active");
            
                // 🔁 Move to next image (wrap around)
                const nextIndex = (currentIndex + 1) % images.length;
                images[nextIndex].classList.add("active");
            } //needs event listener
            
            //Move to previous image in carousel for a given card
            function prevSlide({
              index,
              carouselTrackClass = "carousel-track",
              photoActualClass = "carousel-photo"
            }={}) {
                const carousel = document.getElementById(`carousel-${index}`);
                const track = carousel.querySelector(`.${carouselTrackClass}`);
                const images = track.querySelectorAll(`.${photoActualClass}`);
            
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
            function buildCarousel({
                photos, 
                index,
                carouselContainerClass = "carousel",
                carouselBtnClass = "carousel-btn",
                iconOfNextCarouselButtonClass = "carousel-icon",
                carouselTrackClass = "carousel-track",
                photoActualClass = "carousel-photo"
            } = {}) {
            if (!photos.length) return `<div class="no-photo">No Photos</div>`;
            
            return `
                <div class="${carouselContainerClass}" id="carousel-${index}">
                    <button class="${carouselBtnClass} left" data-carousel-index="${index}" data-dir="prev">
                        <i data-lucide="chevron-left" class="${iconOfNextCarouselButtonClass}"></i>
                    </button>
                    <div class="${carouselTrackClass}">
                        ${photos.map((photo, i) => `
                        <img src="${photo}" class="${photoActualClass} ${i === 0 ? 'active' : ''}" />
                        `).join('')}
                    </div>
                    <button class="${carouselBtnClass} right" data-carousel-index="${index}" data-dir="next">
                        <i data-lucide="chevron-right" class="${iconOfNextCarouselButtonClass}"></i>
                    </button>
                </div>
            `;
           
            }    
        //#endregion
        
        //build the HTML of the card content
        function buildCardContent({
          item,
          chipCardDisplayClass = "category-chip",
          chipSectionTitleClass = "chip-section-label",
          chipContainerClass = "category-chips",
          cardContentOutsidePictureClass = "stock-content",
          hiddenFieldsCardContent = [],
          debug = false
        } = {}) {
          const stock = typeof item.stock === "number" ? item.stock : 0;
          const stockClass = stock === 0 ? "stock-zero" : "";
        
          const show = (field) => !hiddenFieldsCardContent.includes(field); // ✅ Clean utility
        
          const stockLabel = stock === 0
            ? `<p class="stock-count ${stockClass}">
                 <i data-lucide="alert-circle" class="stock-alert-icon"></i> In Stock: ${stock}
               </p>`
            : `<p class="stock-count">In Stock: ${stock}</p>`;
        
          const categoryChips = (item.categories || []).map(cat => `
            <div class="${chipCardDisplayClass}" data-cat="${cat}" data-id="${item.id}">
              ${cat}
            </div>
          `).join("");
        
          const html = `
            <div class="${cardContentOutsidePictureClass}">
              ${show("title") ? `<h2>${item.title}</h2>` : ""}
              ${show("description") ? `<p>${item.description}</p>` : ""}
              ${show("weight") ? `<p><strong>Weight:</strong> ${item.weight}</p>` : ""}
              ${show("cost") ? `<p><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>` : ""}
              ${show("sale_price") ? `<p><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>` : ""}
              ${show("barcode") ? `<p><strong>Barcode:</strong> ${item.barcode || "—"}</p>` : ""}
              ${show("created_at") ? `<p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>` : ""}
              ${show("dymo_label_url") ? `<p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>` : ""}
              ${show("stock") ? stockLabel : ""}
              ${show("units_scanned") ? `<p class="units-scanned"><strong>Units Scanned:</strong> 1</p>` : ""}
              ${show("categories") ? `
                <p class="${chipSectionTitleClass}">Categories:</p>
                <div class="${chipContainerClass}">
                  ${categoryChips}
                </div>
              ` : ""}
            </div>
          `;
        
          if (debug) {
            console.log("[DEBUG] Generated Card HTML for barcode:", item.barcode, html);
          }
        
          return html;
        }
              
        //function to coordinate the rendering of one single item
        function renderInventoryItem({
            item,
            index, 
            CardContainerClass = "stock-card", 
            ImageContainerClass = "stock-image-container", 
            Identifier = "id",
            chipOneCardDisplayClass = "category-chip",
            chipOneSectionTitleClass = "chip-section-label",
            chipOneContainerClass = "category-chips",
            cardOneContentOutsidePictureClass = "stock-content",
            carouselOneContainerClass = "carousel",
            carouselOneBtnClass = "carousel-btn",
            iconOneOfNextCarouselButtonClass = "carousel-icon",
            carouselOneTrackClass = "carousel-track",
            photoOneActualClass = "carousel-photo",
            hiddenOneFieldsCardContent = []
        } = {}) { 
            const card = document.createElement("div");
            card.className = CardContainerClass;
            card.style.position = "relative"; /**This will ensure all children inside
            this cards are positioned related to it */
            card.dataset.itemId = item[Identifier]; /** this is going to give to that card 
            object a specific id, which is going to be in the id column (key) of the item
            (row from data array)
            now the good thing is that this can be used by an event listener*/
        
            const photoCarousel = buildCarousel({
              photos: item.photos || [], 
              index: index,
              carouselContainerClass: carouselOneContainerClass,
              carouselBtnClass: carouselOneBtnClass,
              iconOfNextCarouselButtonClass: iconOneOfNextCarouselButtonClass,
              carouselTrackClass: carouselOneTrackClass,
              photoActualClass: photoOneActualClass

            });
            const content = buildCardContent({
                item: item,
                chipCardDisplayClass: chipOneCardDisplayClass,
                chipSectionTitleClass: chipOneSectionTitleClass,
                chipContainerClass: chipOneContainerClass,
                cardContentOutsidePictureClass: cardOneContentOutsidePictureClass,
                hiddenFieldsCardContent: hiddenOneFieldsCardContent
            });
        
            card.innerHTML = `
            <div class="${ImageContainerClass}">
                ${photoCarousel}
            </div>
            ${content}
            `;
        
            return card;
        }
    //#endregion

    //function to reset the batch once it is done
    function resetBatch() {
        currentBatch = {};
        document.getElementById("batch-items-container").innerHTML = "";
    }

    //function to coordinate card animation on update
    function animateCardUpdate(cardElement) {
      // Remove any animation classes in case they’re still there
      cardElement.classList.remove("updated", "updated-flip", "flash-border");
    
      // Force reflow to restart animation
      void cardElement.offsetWidth;
    
      // Re-add animation classes
      cardElement.classList.add("updated", "updated-flip", "flash-border");
    
      // Clean up after animation
      setTimeout(() => {
        cardElement.classList.remove("flash-border");
      }, 500);
    
      setTimeout(() => {
        cardElement.classList.remove("updated");
        // Optional: keep flip for more visual flair, or remove it here
        cardElement.classList.remove("updated-flip");
      }, 500);
    
      playScanSound();
    }
    
    //function necessary to increment the stock count once the card has been already created
    function incrementCardCount(barcode) {
      const batchItem = currentBatch[barcode];
    
      if (batchItem.count >= batchItem.maxCount) {
        showToast("🚫 This item has already reached its batch limit.");
        showBatchThresholdModal(batchItem); // 🔁 Re-trigger modal every time
        return;
      }
    
      batchItem.count++;

      // 🧼 Remove red glow if previously flagged
      batchItem.cardEl.classList.remove("count-zero-alert");
    
      const unitDisplay = batchItem.cardEl.querySelector(".units-scanned");
      if (unitDisplay) {
        unitDisplay.textContent = `Units Scanned: ${batchItem.count}`;
      }
    
      animateCardUpdate(batchItem.cardEl);
    
      if (batchItem.count >= batchItem.maxCount) {
        showBatchThresholdModal(batchItem); // 👈 Initial trigger
      }
    }
    
    
    
    

    //function to render the card and put into the DOM
    function createCardForItem(item, ContainerForCardInjection = "batch-items-container") {
        const batchContainer = document.getElementById(ContainerForCardInjection); // your target div
        const index = Object.keys(currentBatch).length; // for carousel IDs etc
        const card = renderInventoryItem({ 
        item, 
        index,
        hiddenOneFieldsCardContent: ["dymo_label_url", "description", "barcode", "cost", "created_at"] });
        
        // 🔍 Log the full preview card DOM element and item data
        console.log(" Card Element:", card);

        batchContainer.appendChild(card);
        lucide.createIcons();  

        return card;
    }
      
    //function that will be used to initialize the card for the first time
    function handleScannedItem(item) {
      const card = createCardForItem(item);
    
      currentBatch[item.barcode] = {
        item,
        count: 1,
        maxCount: item.stock_batch_size_update || 10, // 🔢 Use item's custom batch size or default to 10
        cardEl: card
      };
    }
    

    // Function to hide the confirmation modal
    function hideModalToConfirmItem() {
      const modal = document.getElementById("modalToConfirmItem");
      modal.classList.add("hidden"); // Hide the modal
      updateBarcodeInputStateBasedOnModals();
      pendingItem = null; // Clear pending item
    
      // 👉 Refocus barcode input after modal closes
      document.getElementById("input-to-search-inventory-item").focus();
    }

    //function to create listener for the popup to appear
    function setupModalToConfirmItemListeners() {
        const confirmButton = document.getElementById("confirmAddItemBtn");
        const cancelButton = document.getElementById("cancelAddItemBtn");
    
        confirmButton.addEventListener("click", () => {
        if (pendingItem) {
            handleScannedItem(pendingItem);
            pendingItem = null;
        }
        hideModalToConfirmItem();
        });
    
        cancelButton.addEventListener("click", () => {
        hideModalToConfirmItem();
        });
    
        // Optional: Press "Enter" to confirm automatically
        document.addEventListener("keydown", (e) => {
        const modal = document.getElementById("modalToConfirmItem");
        if (!modal.classList.contains("hidden")) {
            if (e.key === "Enter") {
            e.preventDefault();
            confirmButton.click();
            } else if (e.key === "Escape") {
            e.preventDefault();
            cancelButton.click();
            }
        }
        });
    }

    //coorinating the rendering the pop up
    function showModalToConfirmItem(item) {
        pendingItem = item; // Save the item temporarily
    
        const modal = document.getElementById("modalToConfirmItem");
        const modalInfo = document.querySelector("#modalItemInfo"); // ✅ No change here
    
        // Clear any previous content
        modalInfo.innerHTML = "";
    
        // Build the card preview
        const previewCard = renderInventoryItem({
            item,
            index: 0, // Preview just uses index 0
            CardContainerClass: "stock-container-addstock", // 💡 IMPORTANT: match the clean class, not "stock-card" anymore!
            ImageContainerClass: "stock-image-container-addstock",
            Identifier: "id",
            chipOneCardDisplayClass: "category-chip-addstock",
            chipOneSectionTitleClass: "chip-section-label-addstock",
            chipOneContainerClass: "category-chip-containeraddstock",
            cardOneContentOutsidePictureClass: "stock-content-addstock",
            carouselOneContainerClass: "carousel-addstock",
            carouselOneBtnClass: "carousel-btn-addstock",
            iconOneOfNextCarouselButtonClass: "carousel-icon-addstock",
            carouselOneTrackClass: "carousel-track-addstock",
            photoOneActualClass: "carousel-photo-addstock",
            hiddenOneFieldsCardContent: ["dymo_label_url", "description", "barcode", "cost", "created_at"]
        });

        // 🔍 Log the full preview card DOM element and item data
        console.log("Preview Card Element:", previewCard);

    
        modalInfo.appendChild(previewCard);
    
        // Re-activate lucide icons inside the modal
        lucide.createIcons();
    
        // Show the modal
        modal.classList.remove("hidden");
        
        updateBarcodeInputStateBasedOnModals();

    }
    
    //processing of the barcode, if present add, if not, render
    async function processBarcode(barcode) {
      if (!barcode) return;
    
      const input = document.getElementById("input-to-search-inventory-item");
      input.value = "";     // Clear input field
      input.focus();        // Auto-focus back for next scan
    
      if (currentBatch[barcode]) {
        incrementCardCount(barcode);
      } else {
        const item = await ExtractItemWithBarcodeFromSupabase(barcode, "item_types", "barcode", true);
        if (item) {
          showModalToConfirmItem(item);
        }
      }
    }
      
    //listener for the barcode
    function searchForBarcodeListener() {
        const input = document.getElementById("input-to-search-inventory-item");
        let debounceTimer = null;
      
        input.addEventListener("input", () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            processBarcode(input.value.trim());
          }, 200);
        });
    }

    //manual verification listerner count 
    setupManualCountVerificationListeners();


//#endregion  
    

document.addEventListener("DOMContentLoaded", async () => {
    const { data: { session }, error } = await supabase.auth.getSession();
  
    if (!session) {
      showToast("Please log in to scan items.");
      console.error("Session not found.");
      // Redirect to login
      setTimeout(() => {
        window.location.href = "login.html";
      }, 1500);
      return;
    }
  
    console.log("✅ Session loaded. User is authenticated.");
    searchForBarcodeListener();
    document.getElementById("input-to-search-inventory-item").focus();


    //event listeners

    document.addEventListener("click", (e) => {
        const id = e.target.dataset.id; // Common data-id used for most card actions

        // ⏪⏩ Carousel navigation: previous or next
        if (e.target.matches(".carousel-btn-addstock")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide({
              index: index,
              carouselTrackClass: "carousel-track-addstock",
              photoActualClass: "carousel-photo-addstock"
            }) : 
            nextSlide({
              index: index,
              carouselTrackClass: "carousel-track-addstock",
              photoActualClass: "carousel-photo-addstock"
            });      // go left or right
          }
        }

        if (e.target.matches(".carousel-btn")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide({
              index: index,
              carouselTrackClass: "carousel-track",
              photoActualClass: "carousel-photo"
            }) : 
            nextSlide({
              index: index,
              carouselTrackClass: "carousel-track",
              photoActualClass: "carousel-photo"
            });      // go left or right
          }
        }

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

    //event listener for the confirm manual count
    setupModalToConfirmItemListeners();

    //event listener for error if the manual count does not match scanned count
    setupMismatchResetModalListener();

    //event listener to assign the location to an item 
    setupAssignLocationModalListeners();

    //event listener to add locations to the locations table
    setupLocationModalListeners();

    // 🔁 Always refocus on barcode input when clicking outside modal or toast
    document.addEventListener("click", (e) => {
      const input = document.getElementById("input-to-search-inventory-item");
      const modal = document.getElementById("modalToConfirmItem");

      const clickedInsideModal = modal && modal.contains(e.target);
      const clickedToast = e.target.closest("#toast-container");
      const clickedInput = e.target === input;

      if (!clickedInsideModal && !clickedToast && !clickedInput) {
        input.focus();
      }
    });


});
  
//7b41b8f