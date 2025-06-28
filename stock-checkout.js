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

        // ✅ NEW: when entering checkout mode, restore visuals from cart
        if (checkoutMode) {
        cart.forEach(item => {
            const checkbox = document.querySelector(`.select-checkbox[data-id="${item.item_id}"]`);
            if (checkbox) checkbox.checked = true;

            const card = checkbox?.closest('.stock-card');
            if (card) card.classList.add("in-cart");
        });
        }
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
        saveCartToStorage(); // ← ADD THIS
        renderCartItems();
    }

    //function to remove from cart once deselected
    function removeFromCart(itemId) {
        cart = cart.filter(item => item.item_id !== itemId);

        const card = document.querySelector(`.stock-card [data-id="${itemId}"]`)?.closest('.stock-card');
        if (card) card.classList.remove("in-cart");

        updateCartUI();       // update badge / toggle visibility
        saveCartToStorage(); // ← ADD THIS
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

            // === 💳 Subtract credit
            let creditValue = 0;
            const creditEl = document.getElementById("credit-value-display");
            if (creditEl) {
                const raw = creditEl.textContent.replace("$", "");
                creditValue = parseFloat(raw) || 0;
            }

            const adjustedTotal = -creditValue;

            const totalPriceEl = document.getElementById("cart-total-price");
            const itemCountEl = document.getElementById("cart-item-count");

            const label = adjustedTotal < 0 ? "Balance Left" : adjustedTotal > 0 ? "Owes Store" : "Total";
            const colorClass = adjustedTotal < 0 ? "credit-positive" : adjustedTotal > 0 ? "credit-negative" : "credit-neutral";

            if (totalPriceEl) {
                totalPriceEl.innerHTML = `<span class="${colorClass}">${label}: $${adjustedTotal.toFixed(2)}</span>`;
            }
            if (itemCountEl) {
                itemCountEl.textContent = "0 items";
            }

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
                saveCartToStorage(); // ← ADD THIS
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
                saveCartToStorage(); // ← ADD THIS
                renderCartItems();
            });
        });

        // Update total price and item count
        // === 🧮 Calculate subtotal
        const subtotal = cart.reduce((sum, item) => sum + (item.sale_price * (item.qty || 1)), 0);
        const itemCount = cart.reduce((sum, item) => sum + (item.qty || 1), 0);

        // === 💳 Subtract credit
        let creditValue = 0;
        const creditEl = document.getElementById("credit-value-display");
        if (creditEl) {
        const raw = creditEl.textContent.replace("$", "");
        creditValue = parseFloat(raw) || 0;
        }

        const adjustedTotal = subtotal - creditValue;

        // === 🧾 DOM Elements
        const totalPriceEl = document.getElementById("cart-total-price");
        const itemCountEl = document.getElementById("cart-item-count");

        // === 🖼️ Label logic
        const label = adjustedTotal < 0 ? "Balance Left" : adjustedTotal > 0 ? "Owes Store" : "Total";
        const colorClass = adjustedTotal < 0 ? "credit-positive" : adjustedTotal > 0 ? "credit-negative" : "credit-neutral";
        // === 📊 Generate concise summary with subtotal and credits only (no grand total)
        const previewSummaryContainer = document.getElementById("cart-preview-summary-display");
        if (previewSummaryContainer) {
        let summaryHtml = "";
        summaryHtml += `<p><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</p>`;

        if (creditValue > 0) {
            summaryHtml += `<p><strong>Credits Applied:</strong> -$${creditValue.toFixed(2)}</p>`;
        }

        previewSummaryContainer.innerHTML = summaryHtml;
        previewSummaryContainer.classList.remove("hidden");
        }

        if (totalPriceEl) {
        totalPriceEl.innerHTML = `<span class="${colorClass}">${label}: $${adjustedTotal.toFixed(2)}</span>`;
        }
        if (itemCountEl) {
        itemCountEl.textContent = `${itemCount} item${itemCount !== 1 ? "s" : ""}`;
        }

    }

    //function to set up the listener
    function setupCartPanelListeners() {
        const toggleBtn = document.getElementById("cart-toggle-btn");
        const panel = document.getElementById("cart-panel");
        const closeBtn = document.getElementById("close-cart-panel");

        if (!toggleBtn || !panel || !closeBtn) return;

        toggleBtn.addEventListener("click", () => {
            panel.classList.toggle("hidden");
            document.body.classList.toggle("cart-open", !panel.classList.contains("hidden"));
        });

        closeBtn.addEventListener("click", () => {
            panel.classList.add("hidden");
            document.body.classList.remove("cart-open");
        });

        // ✅ Handle empty cart
        const emptyBtn = document.getElementById("empty-cart-btn");
        if (emptyBtn) {
            emptyBtn.addEventListener("click", () => {
            if (confirm("Are you sure you want to empty the cart?")) {
                clearCart();
            }
            });
        }
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

    // === 🔁 Cart Tab Switching Logic ===
    function setupCartTabs() {
        const tabButtons = document.querySelectorAll(".cart-tab-btn");
        const tabContents = document.querySelectorAll(".cart-tab-content");

        tabButtons.forEach(btn => {
            btn.addEventListener("click", () => {
            const targetTab = btn.dataset.tab;

            // Activate selected button
            tabButtons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");

            // Show the correct content section
            tabContents.forEach(section => {
                section.classList.toggle("active", section.id === targetTab);
            });

            // If switching to the cart view, re-render items and recalculate
            if (targetTab === "cart-view") {
                renderCartItems();
            }

            // If switching to the credits view, recalculate total credits
            if (targetTab === "credits-view") {
                updateCreditValue();
            }

            // Always recalculate final total when switching views
            calculateFinalCheckoutTotal();
            });
        });
    }


    // === 💳 Credit Calculation Logic ===
    function setupCreditTierListeners() {
        const inputs = [
            { id: "credit-3mm", value: 20 },
            { id: "credit-5mm", value: 35 },
            { id: "credit-8mm", value: 50 }
        ];

        inputs.forEach(({ id }) => {
            const input = document.getElementById(id);
            if (input) {
            input.addEventListener("input", updateCreditValue);
            }
        });
    }

    function updateCreditValue() {
        const tierLabels = {
            "credit-3mm": { label: "3mm Tier", emoji: "💎", value: 20 },
            "credit-5mm": { label: "5mm Tier", emoji: "🔷", value: 35 },
            "credit-8mm": { label: "8mm Tier", emoji: "🟣", value: 50 }
        };

        let totalCredit = 0;
        let breakdownHtml = "";
        let anyInput = false;

        for (const id in tierLabels) {
            const input = document.getElementById(id);
            const count = parseInt(input?.value || "0");
            const unitValue = tierLabels[id].value;

            if (count > 0) {
            anyInput = true;
            const lineTotal = count * unitValue;

            breakdownHtml += `
                <p class="credit-breakdown-line">
                <span class="tier-emoji">${tierLabels[id].emoji}</span>
                <span class="tier-label">${tierLabels[id].label}</span>
                <span class="math-line">→ ${count} × $${unitValue.toFixed(2)} = <strong>$${lineTotal.toFixed(2)}</strong></span>
                </p>
            `;

            totalCredit += lineTotal;
            }
        }

        const display = document.getElementById("credit-value-display");
        if (display) display.textContent = `$${totalCredit.toFixed(2)}`;

        const breakdownContainer = document.getElementById("credit-breakdown-display");
        if (breakdownContainer) {
            if (anyInput) {
            breakdownContainer.innerHTML = breakdownHtml;
            breakdownContainer.classList.remove("hidden");
            } else {
            breakdownContainer.classList.add("hidden");
            breakdownContainer.innerHTML = "";
            }
        }
        return totalCredit;
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
                <div class="item-info-flex">
                <div class="title-qty-row">
                    <p class="item-title"><strong>${item.title}</strong> — $${item.sale_price.toFixed(2)}</p>
                    <div class="checkout-qty-controls">
                    <button class="qty-decrease" data-id="${item.item_id}">−</button>
                    <span class="checkout-qty-count">${item.qty}</span>
                    <button class="qty-increase" data-id="${item.item_id}">+</button>
                    </div>
                </div>
                </div>
            </div>
            <div class="discount-row">
                <label class="discount-label">Discount for this item:</label>
                <div class="discount-inline-inputs">
                <input
                    type="number"
                    min="0"
                    max="100"
                    class="item-discount-input-percent"
                    placeholder="0"
                    data-id="${item.item_id}"
                    data-original-price="${item.sale_price.toFixed(2)}"
                    data-qty="${item.qty}"
                /> %
                or
                <input
                    type="number"
                    min="0"
                    class="item-discount-input-absolute"
                    placeholder="0"
                    data-id="${item.item_id}"
                    data-original-price="${item.sale_price.toFixed(2)}"
                    data-qty="${item.qty}"
                /> $
                </div>
                <p class="discounted-price-preview">💲 <span class="discounted-price-value" id="discounted-${item.item_id}">$${(item.sale_price * item.qty).toFixed(2)}</span></p>
            </div>
            `;

            container.appendChild(itemRow);
        });

        // Attach live quantity control handlers
        container.querySelectorAll(".qty-increase").forEach(btn => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const target = cart.find(i => i.item_id === id);
                if (target) {
                target.qty += 1;
                updateCartUI();         // ✅ update badge + toggle
                saveCartToStorage(); // ← ADD THIS
                renderCartItems();      // ✅ update side cart panel
                openCheckoutModal();    // ✅ re-render modal
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
                cart.splice(cart.findIndex(i => i.item_id === id), 1);
                }
                updateCartUI();         // ✅ update badge + toggle
                saveCartToStorage(); // ← ADD THIS
                renderCartItems();      // ✅ update side cart panel
                openCheckoutModal();    // ✅ re-render modal
            });
        });

        // Generate credit breakdown HTML for checkout modal
        const checkoutBreakdownEl = document.getElementById("checkout-credit-breakdown");
        if (checkoutBreakdownEl) {
        const tierLabels = {
            "credit-3mm": { label: "3mm Tier", emoji: "💎", value: 20 },
            "credit-5mm": { label: "5mm Tier", emoji: "🔷", value: 35 },
            "credit-8mm": { label: "8mm Tier", emoji: "🟣", value: 50 }
        };

        let breakdownHtml = "";
        let anyInput = false;

        for (const id in tierLabels) {
            const input = document.getElementById(id);
            const count = parseInt(input?.value || "0");
            const unitValue = tierLabels[id].value;

            if (count > 0) {
            anyInput = true;
            const lineTotal = count * unitValue;
            breakdownHtml += `
                <p class="credit-breakdown-line">
                <span class="tier-emoji">${tierLabels[id].emoji}</span>
                <span class="tier-label">${tierLabels[id].label}</span>
                <span class="math-line">→ ${count} × $${unitValue.toFixed(2)} = <strong>$${lineTotal.toFixed(2)}</strong></span>
                </p>
            `;
            }
        }

        if (anyInput) {
            checkoutBreakdownEl.innerHTML = breakdownHtml;
            checkoutBreakdownEl.classList.remove("hidden");
        } else {
            checkoutBreakdownEl.innerHTML = "";
            checkoutBreakdownEl.classList.add("hidden");
        }
        }

        const checkoutSummaryEl = document.getElementById("checkout-summary-display");
        if (checkoutSummaryEl) {
        const subtotal = cart.reduce((sum, item) => sum + (item.sale_price * (item.qty || 1)), 0);

        const creditEl = document.getElementById("credit-value-display");
        const rawCredit = creditEl?.textContent.replace("$", "") || "0";
        const creditValue = parseFloat(rawCredit) || 0;

        const finalBalance = subtotal - creditValue;

        const balanceLabel = finalBalance < 0 ? "Balance Left" : finalBalance > 0 ? "Owes Store" : "Settled";
        const colorClass = finalBalance < 0 ? "credit-positive" : finalBalance > 0 ? "credit-negative" : "credit-neutral";

        // Calculate total discount amount
        let totalDiscount = 0;
        cart.forEach(item => {
        const discountInput = document.querySelector(`.item-discount-input-percent[data-id="${item.item_id}"]`);
        const discountPercent = discountInput ? parseFloat(discountInput.value) || 0 : 0;
        const originalTotal = item.sale_price * item.qty;
        totalDiscount += originalTotal * (discountPercent / 100);
        });

        checkoutSummaryEl.innerHTML = `
        <div class="checkout-summary-card">
            <p><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</p>
            <p><strong>Discounts Applied:</strong> -$${totalDiscount.toFixed(2)}</p>
            <p><strong>Credits Applied:</strong> -$${creditValue.toFixed(2)}</p>
            <p class="${colorClass}"><strong>${balanceLabel}:</strong> $${finalBalance.toFixed(2)}</p>
        </div>
        `;

        checkoutSummaryEl.classList.remove("hidden");
        }

        // Live update: sync absolute discount → percent input
        container.querySelectorAll(".item-discount-input-absolute").forEach(input => {
        input.addEventListener("input", () => {
            const id = input.dataset.id;
            const absoluteValue = parseFloat(input.value) || 0;
            const originalPrice = parseFloat(input.dataset.originalPrice) || 0;
            const qty = parseInt(input.dataset.qty) || 1;

            const maxDiscount = originalPrice * qty;
            const cappedValue = Math.min(absoluteValue, maxDiscount);
            const calculatedPercent = (cappedValue / maxDiscount) * 100;

            const percentInput = container.querySelector(`.item-discount-input-percent[data-id="${id}"]`);
            if (percentInput) percentInput.value = calculatedPercent.toFixed(0);

            calculateFinalCheckoutTotal();
        });
        });

        // Live update: sync percent discount → absolute input
        container.querySelectorAll(".item-discount-input-percent").forEach(input => {
        input.addEventListener("input", () => {
            const id = input.dataset.id;
            const percentValue = parseFloat(input.value) || 0;
            const originalPrice = parseFloat(input.dataset.originalPrice) || 0;
            const qty = parseInt(input.dataset.qty) || 1;

            const maxDiscount = originalPrice * qty;
            const calculatedAbsolute = (percentValue / 100) * maxDiscount;

            const absoluteInput = container.querySelector(`.item-discount-input-absolute[data-id="${id}"]`);
            if (absoluteInput) absoluteInput.value = calculatedAbsolute.toFixed(2);

            calculateFinalCheckoutTotal();
        });
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

        // === Listen to Apply Credit Tier button inside the modal
        document.getElementById("open-credit-modal")?.addEventListener("click", () => {
            // 1️⃣ Close the checkout modal
            closeCheckoutModal();

            // 2️⃣ Make sure the cart panel is open
            const cartPanel = document.getElementById("cart-panel");
            cartPanel.classList.remove("hidden");
            document.body.classList.add("cart-open");

            // 3️⃣ Activate the credits tab
            const tabButtons = document.querySelectorAll(".cart-tab-btn");
            const tabContents = document.querySelectorAll(".cart-tab-content");

            tabButtons.forEach(btn => btn.classList.remove("active"));
            tabContents.forEach(content => content.classList.remove("active"));

            const creditsTabBtn = document.querySelector('.cart-tab-btn[data-tab="credits-view"]');
            const creditsTabContent = document.getElementById("credits-view");

            creditsTabBtn?.classList.add("active");
            creditsTabContent?.classList.add("active");
        });

    }


    // === Main Calculation Function
    function calculateFinalCheckoutTotal() {
        const cart = checkoutModule.getCart();
        const generalDiscountPercent = parseFloat(document.getElementById("general-discount").value) || 0;
        const finalTotalEl = document.getElementById("checkout-final-price");

        let subtotalBeforeDiscounts = 0;
        let perItemDiscountTotal = 0;
        let subtotalAfterItemDiscounts = 0;

        cart.forEach(item => {
            const percentInput = document.querySelector(`.item-discount-input-percent[data-id="${item.item_id}"]`);
            const absoluteInput = document.querySelector(`.item-discount-input-absolute[data-id="${item.item_id}"]`);

            const qty = item.qty || 1;
            const originalTotal = item.sale_price * qty;

            subtotalBeforeDiscounts += originalTotal;

            let itemDiscountAmount = 0;

            if (absoluteInput && absoluteInput.value) {
                itemDiscountAmount = Math.min(parseFloat(absoluteInput.value) || 0, originalTotal);
            } else if (percentInput && percentInput.value) {
                const percent = parseFloat(percentInput.value) || 0;
                itemDiscountAmount = (percent / 100) * originalTotal;
            }

            perItemDiscountTotal += itemDiscountAmount;

            const totalAfterItemDiscount = originalTotal - itemDiscountAmount;
            subtotalAfterItemDiscounts += totalAfterItemDiscount;

            // 🔄 Update the live discounted price preview
            const previewEl = document.getElementById(`discounted-${item.item_id}`);
            if (previewEl) {
                previewEl.textContent = `$${totalAfterItemDiscount.toFixed(2)}`;
            }
        });

        // ➕ General discount on subtotal after item-level discounts
        const generalDiscountAmount = (generalDiscountPercent / 100) * subtotalAfterItemDiscounts;

        // 💳 Credits
        let creditValue = 0;
        const creditEl = document.getElementById("credit-value-display");
        if (creditEl) {
            const raw = creditEl.textContent.replace("$", "");
            creditValue = parseFloat(raw) || 0;
        }

        // ➕ Calculate final total
        const final = subtotalAfterItemDiscounts - generalDiscountAmount - creditValue;
        finalTotalEl.textContent = `$${final.toFixed(2)}`;

        // ✅ Update summary card with separated discount lines
        const checkoutSummaryEl = document.getElementById("checkout-summary-display");
        if (checkoutSummaryEl) {
            const balanceLabel = final < 0 ? "Balance Left" : final > 0 ? "Owes Store" : "Settled";
            const colorClass = final < 0 ? "credit-positive" : final > 0 ? "credit-negative" : "credit-neutral";

            checkoutSummaryEl.innerHTML = `
                <div class="checkout-summary-card">
                    <p><strong>Subtotal:</strong> $${subtotalBeforeDiscounts.toFixed(2)}</p>
                    <p><strong>Per-item Discounts:</strong> -$${perItemDiscountTotal.toFixed(2)}</p>
                    <p><strong>General Discount:</strong> -$${generalDiscountAmount.toFixed(2)}</p>
                    <p><strong>Credits Applied:</strong> -$${creditValue.toFixed(2)}</p>
                    <p class="${colorClass}"><strong>${balanceLabel}:</strong> $${final.toFixed(2)}</p>
                </div>
            `;
            checkoutSummaryEl.classList.remove("hidden");
        }
    }
  //#endregion

  //#region logic to be able to preserve the cart even if something changes by accident
    const STORAGE_KEY = "checkout-cart-og";

    function saveCartToStorage() {
        const dataToStore = {
            cart,
            generalDiscount: parseFloat(document.getElementById("general-discount")?.value || "0"),
            credits: {
                credit3mm: parseInt(document.getElementById("credit-3mm")?.value || "0"),
                credit5mm: parseInt(document.getElementById("credit-5mm")?.value || "0"),
                credit8mm: parseInt(document.getElementById("credit-8mm")?.value || "0"),
            },
            perItemDiscounts: cart.map(item => ({
                item_id: item.item_id,
                percent: parseFloat(document.querySelector(`.item-discount-input-percent[data-id="${item.item_id}"]`)?.value || "0"),
                absolute: parseFloat(document.querySelector(`.item-discount-input-absolute[data-id="${item.item_id}"]`)?.value || "0")
            }))
        };

        localStorage.setItem("checkout-cart-og", JSON.stringify(dataToStore));
    }

    async function loadCartFromStorage() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return;

        try {
            const rawCart = JSON.parse(stored);
            const signedCart = await Promise.all(
                rawCart.map(async (item) => {
                    const signedUrl = await resolveImageUrl(item.image_url || "");
                    return {
                        ...item,
                        image_url: signedUrl,
                    };
                })
            );
            cart = signedCart;

            // 🔁 Update visuals after loading
            updateCartUI();
            renderCartItems();

            // ✅ Optional: visually restore "in-cart" style
            signedCart.forEach(item => {
                const card = document.querySelector(`.stock-card [data-id="${item.item_id}"]`)?.closest('.stock-card');
                if (card) card.classList.add("in-cart");
            });

        } catch (e) {
            console.warn("❌ Could not parse or sign stored cart items:", e);
            cart = [];
        }
    }

    function clearCart() {
        cart = [];
        localStorage.removeItem(STORAGE_KEY);

        // 🔄 Uncheck all select checkboxes and remove "in-cart" highlights
        document.querySelectorAll(".select-checkbox").forEach(cb => cb.checked = false);
        document.querySelectorAll(".stock-card.in-cart").forEach(card => card.classList.remove("in-cart"));

        updateCartUI();
        saveCartToStorage();
        renderCartItems();
    }


  //#endregion

    (async () => {
    await loadCartFromStorage();
    })();


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
    clearCart,
    renderCartItems,        // ✅ add this
    loadCartFromStorage,    // ✅ and this
    setupCartTabs,
    setupCreditTierListeners,
  };
})();
