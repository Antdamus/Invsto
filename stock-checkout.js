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
    async function handleCardClickForCheckout(cardElement) {
        if (!cardElement) return;

        let itemId = cardElement.dataset.id;

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

        const photoRef = (item.photoPaths || item.photos || [])[0] || null;
        const signedUrl = await resolveImageUrl(photoRef);

        const cartItem = {
            item_id: item.id,
            title: item.title || "Untitled",
            sale_price: parseFloat(item.sale_price || "0"),
            image_url: signedUrl
        };

        addToCart(cartItem);
        renderCartItems();
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

        container.innerHTML = "";

        if (cart.length === 0) {
            container.innerHTML = `<p class="cart-empty">🕳️ Your cart is empty</p>`;
            document.getElementById("cart-total-price").textContent = "$0.00";
            document.getElementById("cart-item-count").textContent = "0 items";
            return;
        }

        cart.forEach(item => {
            const div = document.createElement("div");
            div.className = "cart-item";
            div.innerHTML = `
            <img loading="lazy" src="${item.image_url || 'https://via.placeholder.com/60x60?text=No+Image'}" alt="${item.title}" class="cart-thumb" />
            <div class="cart-item-details">
                <p class="cart-item-title">${item.title}</p>
                <p class="cart-item-price">$${item.sale_price.toFixed(2)}</p>
                <div class="cart-qty-controls">
                <button class="qty-decrease" data-id="${item.item_id}" title="Decrease the quantity of the item">−</button>
                <span class="cart-qty-count">${item.qty}</span>
                <button class="qty-increase" data-id="${item.item_id}" title="Increase the quantity of the item">+</button>
                </div>
            </div>
            `;
            container.appendChild(div);
        });

        // Attach listeners after injecting items
        container.querySelectorAll(".qty-increase").forEach(btn => {
            btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const target = cart.find(i => i.item_id === id);
            if (target) {
                target.qty += 1;
                updateCartUI();
                renderCartItems();
            }
            });
        });

        container.querySelectorAll(".qty-decrease").forEach(btn => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const target = cart.find(i => i.item_id === id);
                if (target && target.qty > 1) {
                target.qty -= 1;
                } else {
                // If qty reaches 0, remove the item from cart
                cart = cart.filter(i => i.item_id !== id);

                // 🔄 Uncheck the select checkbox if it exists
                const checkbox = document.querySelector(`.select-checkbox[data-id="${id}"]`);
                if (checkbox) checkbox.checked = false;

                // 🧼 Also remove the in-cart highlight
                const card = checkbox?.closest('.stock-card');
                if (card) card.classList.remove("in-cart");
                }
                updateCartUI();
                renderCartItems();
            });
        });

        // Update total price and item count
        const total = cart.reduce((sum, item) => sum + (item.sale_price * (item.qty || 1)), 0);
        const itemCount = cart.reduce((sum, item) => sum + (item.qty || 1), 0);
        const totalPriceEl = document.getElementById("cart-total-price");
        const itemCountEl = document.getElementById("cart-item-count");

        if (totalPriceEl) totalPriceEl.textContent = `$${total.toFixed(2)}`;
        if (itemCountEl) itemCountEl.textContent = `${itemCount} item${itemCount !== 1 ? "s" : ""}`;
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

    //resolve the URL 
    // Uses shared image signing logic from stock.js
    async function resolveImageUrl(photoRef) {
        if (!photoRef || typeof photoRef !== "string") return null;

        // If it's already a full URL (signed), use as-is
        if (photoRef.startsWith("https://")) return photoRef;

        // Otherwise sign it using global stock.js helper
        const url = await getSignedUrl(photoRef);
        return url || "https://placehold.co/60x60?text=No+Img";
    }

  //#endregion

  //#region funciton to open and close the checkout modal and make it operational modal Control & Discount Logic
    function openCheckoutModal() {
        const modal = document.getElementById("checkout-modal");
        const container = document.getElementById("checkout-items-container");
        const generalDiscountInput = document.getElementById("general-discount");
        const finalTotalEl = document.getElementById("checkout-final-price");

        const cart = checkoutModule.getCart();
        container.innerHTML = "";

        if (cart.length === 0) {
            container.innerHTML = "<p class='cart-empty'>🕳️ Cart is empty</p>";
            finalTotalEl.textContent = "$0.00";
            modal.classList.remove("hidden");
            document.body.classList.add("modal-open");
            return;
        }

        cart.forEach(item => {
            const itemRow = document.createElement("div");
            itemRow.className = "checkout-item-card";
            itemRow.setAttribute("data-item-id", item.item_id);

            itemRow.innerHTML = `
            <div class="item-header">
                <img class="checkout-item-image" src="${item.image_url || 'https://via.placeholder.com/60'}" alt="${item.title}" />
                <p class="item-title"><strong>${item.title}</strong> — $${item.sale_price.toFixed(2)} × ${item.qty}</p>
            </div>
            <div class="discount-row">
                <label class="discount-label">Discount for this item:</label>
                <div class="discount-inline-input">
                    <input
                    type="number"
                    min="0"
                    max="100"
                    class="item-discount-input"
                    placeholder="0"
                    data-id="${item.item_id}"
                    data-original-price="${item.sale_price.toFixed(2)}"
                    data-qty="${item.qty}"
                    />
                </div>
                <p class="discounted-price-preview">💲 <span class="discounted-price-value" id="discounted-${item.item_id}">$${(item.sale_price * item.qty).toFixed(2)}</span></p>
            </div>
            `;

            container.appendChild(itemRow);
        });

        generalDiscountInput.value = "";
        calculateFinalCheckoutTotal();

        modal.classList.remove("hidden");
        document.body.classList.add("modal-open");
    }


    function closeCheckoutModal() {
    document.getElementById("checkout-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    }

    // === Attach modal listeners
    function setupCheckoutModalListeners() {
        document.getElementById("proceed-checkout-btn")?.addEventListener("click", openCheckoutModal);
        document.getElementById("close-checkout-modal")?.addEventListener("click", closeCheckoutModal);
        document.getElementById("general-discount")?.addEventListener("input", calculateFinalCheckoutTotal);

        // Live update per-item discount fields
        document.addEventListener("input", function (e) {
            if (e.target.classList.contains("item-discount-input")) {
            calculateFinalCheckoutTotal();
            }
        });
    }


    // === Main Calculation Function
    function calculateFinalCheckoutTotal() {
        const cart = checkoutModule.getCart();
        const generalDiscount = parseFloat(document.getElementById("general-discount").value) || 0;
        const finalTotalEl = document.getElementById("checkout-final-price");

        let total = 0;

        cart.forEach(item => {
            const input = document.querySelector(`.item-discount-input[data-id="${item.item_id}"]`);
            const discount = input ? parseFloat(input.value) : null;
            const appliedDiscount = isNaN(discount) ? generalDiscount : discount;
            const priceAfter = item.sale_price * (1 - appliedDiscount / 100);
            const totalForItem = priceAfter * item.qty;
            total += totalForItem;

            // 🔁 Update the live discounted price preview
            const previewEl = document.getElementById(`discounted-${item.item_id}`);
            if (previewEl) {
            previewEl.textContent = `$${totalForItem.toFixed(2)}`;
            }
        });

        finalTotalEl.textContent = `$${total.toFixed(2)}`;
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
    setupCheckoutModalListeners, // ← 🧩 new
    resolveImageUrl,
  };
})();
