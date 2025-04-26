
let pendingItem = null; // Store the scanned item awaiting confirmation
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

    // Function to hide the confirmation modal
    function hideModalToConfirmItem() {
        const modal = document.getElementById("modalToConfirmItem");
        modal.classList.add("hidden"); // Hide the modal
        pendingItem = null; // Clear pending item
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
        const modalInfo = document.getElementById("modalItemInfo");
      
        // Clear any previous content
        modalInfo.innerHTML = "";
      
        // Build the card preview
        const previewCard = renderInventoryItem({
          item,
          index: 0, // Preview can just use index 0, no matter
          CardContainerClass: "stock-card preview-mode", // Optional special styling if you want
          ImageContainerClass: "stock-image-container",
          Identifier: "id"
        });
      
        modalInfo.appendChild(previewCard);
      
        // Re-activate lucide icons inside the modal
        lucide.createIcons();
      
        // Show the modal
        modal.classList.remove("hidden");
    }

    //processing of the barcode, if present add, if not, render
    async function processBarcode(barcode) {
        if (!barcode) return;
      
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
  
