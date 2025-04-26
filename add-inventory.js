

const currentBatch = {}; 


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
    

    //#region Rendering card item that matched barcode
        //#region buil image carousel
            //Move to next image in carousel for a given card
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
            
            //Move to previous image in carousel for a given card
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
                    <button class="carousel-btn left" data-carousel-index="${index}" data-dir="prev">
                        <i data-lucide="chevron-left" class="carousel-icon"></i>
                    </button>
                    <div class="carousel-track">
                        ${photos.map((photo, i) => `
                        <img src="${photo}" class="carousel-photo ${i === 0 ? 'active' : ''}" />
                        `).join('')}
                    </div>
                    <button class="carousel-btn right" data-carousel-index="${index}" data-dir="next">
                        <i data-lucide="chevron-right" class="carousel-icon"></i>
                    </button>
                </div>
            `;
           
            }    
        //#endregion
        
        //build the HTML of the card content
        function buildCardContent({
            item,
            chipCardDisplayClass = "category-chip",
            ChipSectionTitleClass = "chip-section-label",
            chipContainerClass = "category-chips",
            cardContentOutsidePictureClass = "stock-content",
            debug = false
          } = {}) {
            const stock = typeof item.stock === "number" ? item.stock : 0;
            const stockClass = stock === 0 ? "stock-zero" : "";
            const stockLabel = stock === 0
              ? `<p class="stock-count ${stockClass}">
                   <i data-lucide="alert-circle" class="stock-alert-icon"></i> In Stock: ${stock}
                 </p>`
              : `<p class="stock-count">In Stock: ${stock}</p>`;
          
            const categoryChips = (item.categories || []).map(cat => {
              return `
                <div class="${chipCardDisplayClass}" data-cat="${cat}" data-id="${item.id}">
                  ${cat}
                </div>
              `;
            }).join("");
          
            const html = `
              <div class="${cardContentOutsidePictureClass}">
                <h2>${item.title}</h2>
                <p>${item.description}</p>
                <p><strong>Weight:</strong> ${item.weight}</p>
                <p><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>
                <p><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>
                <p><strong>Barcode:</strong> ${item.barcode || "—"}</p>
                <p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>
                <p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>
          
                ${stockLabel}
          
                <p class="units-scanned"><strong>Units Scanned:</strong> 1</p> <!-- NEW -->
          
                <p class="${ChipSectionTitleClass}">Categories:</p>
                <div class="${chipContainerClass}">
                  ${categoryChips}
                </div>
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
            Identifier = "id"
        } = {}) { 
            const card = document.createElement("div");
            card.className = CardContainerClass;
            card.style.position = "relative"; /**This will ensure all children inside
            this cards are positioned related to it */
            card.dataset.itemId = item[Identifier]; /** this is going to give to that card 
            object a specific id, which is going to be in the id column (key) of the item
            (row from data array)
            now the good thing is that this can be used by an event listener*/
        
            const photoCarousel = buildCarousel(item.photos || [], index);
            const content = buildCardContent({item});
        
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
      
    
    //function necessary to increment the stock count once the card has been already created
    function incrementCardCount(barcode) {
        const batchItem = currentBatch[barcode];
        batchItem.count++;
      
        // Update the card's Units Scanned visually
        const unitDisplay = batchItem.cardEl.querySelector(".units-scanned"); // You must put a class to find it
        if (unitDisplay) {
          unitDisplay.textContent = `Units Scanned: ${batchItem.count}`;
        }
    }

    //function to render the card and put into the DOM
    function createCardForItem(item, ContainerForCardInjection = "batch-items-container") {
        const batchContainer = document.getElementById(ContainerForCardInjection); // your target div
        const index = Object.keys(currentBatch).length; // for carousel IDs etc
        const card = renderInventoryItem({ item, index });
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
          cardEl: card
        };
    }
      
    //processing of the barcode, if present add, if not, render
    async function processBarcode(barcode) {
        if (!barcode) return;
      
        if (currentBatch[barcode]) {
          incrementCardCount(barcode);
        } else {
          const item = await ExtractItemWithBarcodeFromSupabase(barcode, "item_types", "barcode", true);
          if (item) {
            handleScannedItem(item);
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
          }, 1000);
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

    //event listeners

    document.addEventListener("click", (e) => {
        const id = e.target.dataset.id; // Common data-id used for most card actions

        // ⏪⏩ Carousel navigation: previous or next
        if (e.target.matches(".carousel-btn")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide(index) : nextSlide(index);      // go left or right
          }
        }
      });
});
  
