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

        // Apply visual style to the card
        const card = document.querySelector(`.stock-card [data-id="${item.item_id}"]`)?.closest('.stock-card');
        if (card) card.classList.add("in-cart");
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
            image_url: item.photo_url || null
        };

        addToCart(cartItem);
        console.log("🛒 Updated cart:", getCart());
    }

    //function to remove from cart once deselected
    function removeFromCart(itemId) {
        const originalLength = cart.length;
        cart = cart.filter(item => item.item_id !== itemId);
        if (cart.length !== originalLength) {
            console.log(`❌ Removed item ${itemId} from cart.`);
        }

        // Remove visual style from the card
        const card = document.querySelector(`.stock-card [data-id="${itemId}"]`)?.closest('.stock-card');
        if (card) card.classList.remove("in-cart");
    }

    function getCart() {
        return [...cart];
    }
  //#endregion



  return {
    setupCheckoutToggleButton,
    isCheckoutMode,
    addToCart,
    handleCardClickForCheckout,
    getCart,
    removeFromCart // 👈 add this
  };
})();
