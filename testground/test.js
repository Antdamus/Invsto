
let selectedItems = new Set();  

//#region function to render all the cards (renderstockitems)
    //#region getting the info of the card and the chips rendered
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
                <div class="add-category-chip" data-id="${item.id}">+ Add Category</div> 
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

//#endregion

//#region function render bulk toolbar after event listener capure change in select-box
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
        if the bookean is true it adds the item to the global, otherwise it
        deletes it from the list */
       
        updateBulkToolbar(); /** this function will tell the system to show
        or to hided the div with the bulk-toolbar id, and to update the selected
        count div that will show ho many items have been chosen */

        //const filtered = getFilteredItems(allItems);
        //applySortAndRender(filtered);
    }

//#endregion


//1. first thing is you add an event listener to the DOMContentLoaded

//2. i need to have the function to fetch the items that are currently being selected -->existing utility
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

//3. I need to render all the cards with their respective chips and blocks
// renderStockItems

//4 you need to add an event listener for things such as select and other stuff
//defined in DOM

//5 when you go ahead and you click the select checkbox it needs to
//pull a function that is keeping track of which items are being selected
//which is going to be toggleselectitem, and it will make the bulk toolbar pop up



//then i will need a function to extract unique values or array from a colum in data table --> existing
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


document.addEventListener("DOMContentLoaded", async () => {
    //1: Authenticate and load user and load favorited IDs
    currentUser = (await supabase.auth.getUser()).data.user;
    if (currentUser) {
      const { data: favs } = await supabase
        .from("favorites")
        .select("item_id")
        .eq("user_id", currentUser.id);
      userFavorites = new Set(favs.map(f => f.item_id));
    }

    //2. extract the data
    allItems = await fetchStockItems();
    
    //3. render all the cards
    renderStockItems(allItems)

    //4. set up the listeners for the elements of the cards
    document.addEventListener("click", (e) => { /**e in this case is
        going ot be event object that is click, so for that event object
        you will perform the operations we are designated */
        const id = e.target.dataset.id; /**this will read the data ID atribute
        of the data-id key of the element that was clicked */
      
        if (e.target.matches(".favorite-btn")) { /** this is the class */
          //toggleFavorite(id);
        }

        if (e.target.matches(".remove-category-btn")) {
            //const chip = e.target.closest(".category-chip");
            //const cat = chip?.dataset.cat;
            //const itemId = chip?.dataset.id;
            //if (cat && itemId) removeCategory(itemId, cat);
        }
      
        if (e.target.matches(".add-category-chip")) {
          //showCategoryDropdown(id, e.target);
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
        toggleSelectItem(id, e.target.checked); /**the e.target.check is 
        a simple boolean */
    }
    });
      
  });