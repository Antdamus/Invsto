
let pendingItem = null; // Store the scanned item awaiting confirmation
let currentBatch = {}; 

//#region full logic to what will be done once the item reaches its limit

  //function to coordinate the display of the mmodal
  function showBatchThresholdModal(batchItem) {
    const modal = document.getElementById("modal-batch-threshold-reached");
    const closeBtn = document.getElementById("btn-close-batch-threshold-modal");
    const input = document.getElementById("input-to-search-inventory-item");
  
    modal.classList.remove("hidden");
    input.disabled = true; // 🔒 Disable scanner input
  
    closeBtn.onclick = () => {
      modal.classList.add("hidden");
      input.disabled = false; // ✅ Re-enable scanner input
      input.focus(); // Refocus
    };
  
    modal.dataset.barcode = batchItem.item.barcode;
  }
  

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

    setupModalToConfirmItemListeners();

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