/* ================= general wrapper to call it in other JS files and keep things clean============= */
window.checkoutModule = (function () {
  //global be used to start checkout mode
  let checkoutMode = false;
  let cart = [];

  
  //function to activate the toggle to start the checkout mode
  function setupCheckoutToggleButton(btnId = "toggle-checkout-mode") {
    const btn = document.getElementById(btnId);
    if (!btn) {
      console.warn(`No button found with ID: ${btnId}`);
      return;
    }

    btn.addEventListener("click", () => {
      checkoutMode = !checkoutMode;

      // Update button appearance
      btn.classList.toggle("active", checkoutMode);
      btn.title = checkoutMode ? "Exit Checkout Mode" : "Enter Checkout Mode";

      // Update body styling
      document.body.classList.toggle("checkout-mode-active", checkoutMode);
    });
  }

  function isCheckoutMode() {
    return checkoutMode;
  }

  //#region function to add to cart one i click on the cards and i am in checkout mode
    //function responsible for adding to the card
    function addToCart(item) {
        const existing = cart.find(i => i.item_id === item.item_id);
        if (existing) {
            existing.qty += 1;
        } else {
            cart.push({ ...item, qty: 1 });
        }

        // Visual highlight
        const card = document.querySelector(`.stock-card [data-id="${item.item_id}"]`)?.closest('.stock-card');
        if (card) card.classList.add("in-cart");

        updateCartUI();
    }
    
    //function to add an event listener so the add to cart function is triggered on click (pointing towards)
    function handleCardClickForCheckout(cardElement) {
        if (!cardElement) return;

        // Try to find a valid data-id in the clicked card area
        let itemId = cardElement.dataset.id;

        // If not found directly, check common inner elements
        if (!itemId) {
            const checkbox = cardElement.querySelector(".select-checkbox");
            const favorite = cardElement.querySelector(".favorite-btn");
            itemId = checkbox?.dataset.id || favorite?.dataset.id;
        }

        if (!itemId) {
            console.warn("⚠️ Could not extract item ID from card element.");
            return;
        }

        const item = allItems.find(i => i.id === itemId);
        if (!item) {
            console.warn(`Item with ID ${itemId} not found in allItems`);
            return;
        }

        const cartItem = {
            item_id: item.id,
            title: item.title || "Untitled",
            sale_price: parseFloat(item.sale_price || "0"),
            image_url: (item.photos && item.photos.length > 0) ? item.photos[0] : null
        };

        console.log("🖼️ Cart Image URL:", cartItem.image_url);

        addToCart(cartItem);
        renderCartItems();
        console.log("🛒 Updated cart:", getCart());
    }

    //function to remove from cart once deselected
    function removeFromCart(itemId) {
        cart = cart.filter(item => item.item_id !== itemId);

        const card = document.querySelector(`.stock-card [data-id="${itemId}"]`)?.closest('.stock-card');
        if (card) card.classList.remove("in-cart");

        updateCartUI();       // update badge / toggle visibility
        renderCartItems();    // 💡 refresh the list in the side panel
    }

    function getCart() {
        return [...cart];
    }

  //#endregion

  //#region function to update the cart interface 
    //function to show the interface
    function updateCartUI() {
        const toggleBtn = document.getElementById("cart-toggle-btn");
        const badge = document.getElementById("cart-count-badge");

        if (!toggleBtn || !badge) return;

        const totalQty = cart.reduce((sum, item) => sum + (item.qty || 0), 0);
        const isCartEmpty = cart.length === 0;

        if (isCartEmpty || totalQty === 0) {
            badge.textContent = "0";
            toggleBtn.classList.add("hidden");
        } else {
            badge.textContent = totalQty;
            toggleBtn.classList.remove("hidden");
        }
    }

    //rendering in the cart the items 
    function renderCartItems() {
        const container = document.getElementById("cart-items-container");
        if (!container) return;

        container.innerHTML = ""; // Clear previous content

        if (cart.length === 0) {
            container.innerHTML = `<p class="cart-empty">🕳️ Your cart is empty</p>`;
            return;
        }

        cart.forEach(item => {
            const div = document.createElement("div");
            div.className = "cart-item";
            div.innerHTML = `
            <img src="${item.image_url || 'https://via.placeholder.com/60'}" alt="${item.title}" class="cart-thumb" />
            <div class="cart-item-details">
                <p class="cart-item-title">${item.title}</p>
                <p class="cart-item-price">$${item.sale_price.toFixed(2)}</p>
            </div>
            `;
            container.appendChild(div);
        });
    }

    //function to set up the listener
    function setupCartPanelListeners() {
        const toggleBtn = document.getElementById("cart-toggle-btn");
        const panel = document.getElementById("cart-panel");
        const closeBtn = document.getElementById("close-cart-panel");

        if (!toggleBtn || !panel || !closeBtn) return;

        toggleBtn.addEventListener("click", () => {
            panel.classList.toggle("hidden");
            
            // 🧠 Toggle a class on body to shift layout if needed
             document.body.classList.toggle("cart-open", !panel.classList.contains("hidden"));
        });


        closeBtn.addEventListener("click", () => {
            panel.classList.add("hidden");
            document.body.classList.remove("cart-open");
        });
    }

  //#endregion



  return {
    setupCheckoutToggleButton,
    isCheckoutMode,
    addToCart,
    removeFromCart,
    handleCardClickForCheckout,
    getCart,
    setupCartPanelListeners,
  };
})();
