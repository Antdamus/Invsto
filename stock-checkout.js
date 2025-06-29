/* ================= general wrapper to call it in other JS files and keep things clean============= */
window.checkoutModule = (function () {
    //global be used to start checkout mode
    let checkoutMode = false;
    let cartState = {
        items: [],
        credits: { "credit-3mm": "0", "credit-5mm": "0", "credit-8mm": "0" },
        generalDiscount: "",
        itemDiscounts: {},
        platformFee: 0,
        salesId: "",      // ✅ NEW: Sales ID
        flagged: false,   // ✅ NEW: flag state
    };
    let locksAcquired = false; // 🔐 Tracks if locks have been acquired during current modal session
    let creditTiers = [];

    window.addEventListener("beforeunload", async () => {
    await unlockSelectedLocationsForCurrentUser();
    });

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
            cartState.items.forEach(item => {
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
    const existing = cartState.items.find(i => i.item_id === item.item_id);
    if (existing) {
        existing.qty += 1;
    } else {
        cartState.items.push({ ...item, qty: 1 });
    }

    const card = document.querySelector(`.stock-card [data-id="${item.item_id}"]`)?.closest('.stock-card');
    if (card) card.classList.add("in-cart");

    updateCartUI();
    }

    function removeFromCart(itemId) {
    cartState.items = cartState.items.filter(item => item.item_id !== itemId);

    const card = document.querySelector(`.stock-card [data-id="${itemId}"]`)?.closest('.stock-card');
    if (card) card.classList.remove("in-cart");

    updateCartUI();
    saveCartToStorage();
    renderCartItems();
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
            image_url: signedUrl,                      // for immediate UI use
            photo_path: photoRef,        // permanent storage path
        };

        addToCart(cartItem);
        saveCartToStorage(); // ← ADD THIS
        renderCartItems();
    }

    //function to load credit tiers
    async function loadCreditTiers() {
        const { data, error } = await supabase
            .from("credit_tiers")
            .select("*")
            .order("id");

        if (error) {
            console.error("❌ Failed to load credit tiers:", error.message);
            creditTiers = [];
            return;
        }

        // ✅ Replace the global creditTiers with the fetched data
        creditTiers = data.map(tier => ({
            id: tier.id,               // e.g., "credit-3mm"
            label: tier.label,         // e.g., "3mm Tier"
            emoji: tier.emoji,         // e.g., "💎"
            unit_value: tier.unit_value, // dynamic price from DB
        }));

        //console.log("✅ Loaded credit tiers:", creditTiers);
    }


    function getCart() {
    return [...cartState.items];
    }
  //#endregion

  //#region function to update the cart interface 
    //function to show the interface
    function updateCartUI() {
        const toggleBtn = document.getElementById("cart-toggle-btn");
        const badge = document.getElementById("cart-count-badge");

        if (!toggleBtn || !badge) return;

        const items = cartState.items;
        const totalQty = items.reduce((sum, item) => sum + (item.qty || 0), 0);
        const isCartEmpty = items.length === 0;

        if (isCartEmpty || totalQty === 0) {
            badge.textContent = "0";
            toggleBtn.classList.add("hidden");
        } else {
            badge.textContent = totalQty;
            toggleBtn.classList.remove("hidden");
        }
    }

    async function renderCartItems() {
    const container = document.getElementById("cart-items-container");
    if (!container) return;

    container.innerHTML = "";
    const items = cartState.items;
    if (items.length === 0) {
        container.innerHTML = `<p class="cart-empty">🕳️ Your cart is empty</p>`;
        updateCartSummary(0, 0);
        return;
    }

    items.forEach(async item => {
        const div = document.createElement("div");
        div.className = "cart-item";
        div.setAttribute("data-item-id", item.item_id);
        div.innerHTML = `
        <img loading="lazy" src="${item.image_url || 'https://via.placeholder.com/60x60?text=No+Image'}" alt="${item.title}" class="cart-thumb" />
        <div class="cart-item-details">
            <p class="cart-item-title">${item.title}</p>
            <p class="cart-item-price">$${item.sale_price.toFixed(2)}</p>
            <div class="cart-qty-controls">
            <button class="qty-decrease" data-id="${item.item_id}" title="Decrease the quantity of the item">−</button>
            <span class="cart-qty-count" id="qty-count-${item.item_id}">${item.qty}</span>
            <button class="qty-increase" data-id="${item.item_id}" title="Increase the quantity of the item">+</button>
            </div>
            <div class="cart-location-select" id="location-select-${item.item_id}">
            <p class="location-loading">🔄 Loading locations...</p>
            </div>
        </div>
        `;
        container.appendChild(div);

        try {
        const { data, error } = await supabase
            .from("item_stock_locations")
            .select(`
            id,
            quantity,
            locked_by,
            locked_at,
            location:location_id (id, location_name)
            `)
            .eq("item_id", item.item_id)
            .gt("quantity", 0);

        const selectContainer = div.querySelector(`#location-select-${item.item_id}`);
        if (error || !data) {
            console.error(`Failed to fetch locations for item ${item.item_id}:`, error);
            selectContainer.innerHTML = `<p class="location-error">⚠️ Could not load locations</p>`;
            return;
        }

        if (data.length === 0) {
            selectContainer.innerHTML = `<p class="location-error">❌ No stock available</p>`;
            return;
        }

        const options = data.map(loc => {
            const locked = loc.locked_by !== null || loc.locked_at !== null;
            return `<option value="${loc.id}" data-qty="${loc.quantity}" data-physical-loc-id="${loc.location.id}" ${locked ? "disabled style='color:red;'" : ""}>
            ${loc.location.location_name} (${loc.quantity} in stock)${locked ? " - LOCKED" : ""}
            </option>`;
        }).join("");

        selectContainer.innerHTML = `
            <label>Pick location:</label>
            <select data-item-id="${item.item_id}" class="location-dropdown">
            ${options}
            </select>
        `;

        const dropdown = selectContainer.querySelector("select");

        // ✅ Update cart item when user changes selection
        dropdown.addEventListener("change", e => {
            const selectedLocId = e.target.value;
            const selectedOption = e.target.options[e.target.selectedIndex];
            const availableQty = parseInt(selectedOption.dataset.qty) || 0;
            const physicalLocId = selectedOption.dataset.physicalLocId;

            const cartItem = cartState.items.find(i => i.item_id === item.item_id);
            if (cartItem) {
            cartItem.selected_location_id = selectedLocId;
            cartItem.physical_location_id = physicalLocId;
            cartItem.available_qty = availableQty;
            saveCartToStorage();
            }
        });

        // ✅ Handle pre-selection: if already saved, re-select it and update quantity & physical ID
        if (item.selected_location_id) {
            dropdown.value = item.selected_location_id;
            const preselectedOption = dropdown.querySelector(`option[value="${item.selected_location_id}"]`);
            if (preselectedOption) {
            const availableQty = parseInt(preselectedOption.dataset.qty) || 0;
            const physicalLocId = preselectedOption.dataset.physicalLocId;
            item.available_qty = availableQty;
            item.physical_location_id = physicalLocId;
            }
        } else {
            // ✅ Set first available as default selection
            const firstOption = dropdown.options[0];
            if (firstOption) {
            const selectedLocId = firstOption.value;
            const availableQty = parseInt(firstOption.dataset.qty) || 0;
            const physicalLocId = firstOption.dataset.physicalLocId;

            item.selected_location_id = selectedLocId;
            item.physical_location_id = physicalLocId;
            item.available_qty = availableQty;
            dropdown.value = selectedLocId;
            saveCartToStorage();
            }
        }
        } catch (err) {
        console.error(`Unexpected error fetching locations for item ${item.item_id}:`, err);
        }
    });

    const subtotal = items.reduce((sum, item) => sum + (item.sale_price * (item.qty || 1)), 0);
    const itemCount = items.reduce((sum, item) => sum + (item.qty || 1), 0);
    updateCartSummary(subtotal, itemCount);

    attachCartQtyListeners(items);
    }

    function attachCartQtyListeners(items) {
    document.querySelectorAll(".qty-increase").forEach(btn => {
        btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const target = items.find(i => i.item_id === id);
        if (target) {
            const maxQty = target.available_qty || 0;
            if (maxQty > 0 && target.qty < maxQty) {
            target.qty += 1;
            } else {
            showToast(`❌ Cannot add more than ${maxQty} at the selected location for ${target.title}`, "error");
            }

            const qtyEl = document.getElementById(`qty-count-${id}`);
            if (qtyEl) qtyEl.textContent = target.qty;

            updateCartUI();
            saveCartToStorage();
            updateCartSummary(
            cartState.items.reduce((sum, i) => sum + (i.sale_price * i.qty), 0),
            cartState.items.reduce((sum, i) => sum + i.qty, 0)
            );
        }
        });
    });

    document.querySelectorAll(".qty-decrease").forEach(btn => {
        btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const targetIndex = items.findIndex(i => i.item_id === id);
        if (targetIndex !== -1) {
            const target = items[targetIndex];
            if (target.qty > 1) {
            target.qty -= 1;
            const qtyEl = document.getElementById(`qty-count-${id}`);
            if (qtyEl) qtyEl.textContent = target.qty;
            } else {
            cartState.items = items.filter(i => i.item_id !== id);
            delete cartState.itemDiscounts[id];
            const itemEl = document.querySelector(`.cart-item[data-item-id="${id}"]`);
            if (itemEl) itemEl.remove();

            const checkbox = document.querySelector(`.select-checkbox[data-id="${id}"]`);
            if (checkbox) checkbox.checked = false;
            const card = checkbox?.closest('.stock-card');
            if (card) card.classList.remove("in-cart");
            }
            updateCartUI();
            saveCartToStorage();
            updateCartSummary(
            cartState.items.reduce((sum, i) => sum + (i.sale_price * i.qty), 0),
            cartState.items.reduce((sum, i) => sum + i.qty, 0)
            );
        }
        });
    });
    }

    function updateCartSummary(subtotal, itemCount) {
        let creditValue = 0;
        const creditEl = document.getElementById("credit-value-display");
        if (creditEl) {
            const raw = creditEl.textContent.replace("$", "");
            creditValue = parseFloat(raw) || 0;
        }
        const adjustedTotal = subtotal - creditValue;
        const totalPriceEl = document.getElementById("cart-total-price");
        const itemCountEl = document.getElementById("cart-item-count");
        const label = adjustedTotal < 0 ? "Balance Left" : adjustedTotal > 0 ? "Owes Store" : "Total";
        const colorClass = adjustedTotal < 0 ? "credit-positive" : adjustedTotal > 0 ? "credit-negative" : "credit-neutral";

        const previewSummaryContainer = document.getElementById("cart-preview-summary-display");
        if (previewSummaryContainer) {
            let summaryHtml = `<p><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</p>`;
            if (creditValue > 0) summaryHtml += `<p><strong>Credits Applied:</strong> -$${creditValue.toFixed(2)}</p>`;
            previewSummaryContainer.innerHTML = summaryHtml;
            previewSummaryContainer.classList.remove("hidden");
        }

        if (totalPriceEl) totalPriceEl.innerHTML = `<span class="${colorClass}">${label}: $${adjustedTotal.toFixed(2)}</span>`;
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
        console.log("🔎 Running setupCreditTierListeners, current creditTiers:", creditTiers);

        if (!creditTiers || creditTiers.length === 0) {
            console.warn("⚠️ No credit tiers loaded! Listeners will not be set up.");
            return;
        }

        const inputs = creditTiers.map(tier => ({
            id: tier.id,
            value: tier.unit_value
        }));

        inputs.forEach(({ id }) => {
            const input = document.getElementById(id);
            if (input) {
                console.log(`✅ Setting up listener on credit input: ${id}`);
                input.addEventListener("input", () => {
                    updateCreditValue();
                    saveCartToStorage();
                });
            } else {
                console.warn(`⚠️ No input element found in DOM for credit ID: ${id}`);
            }
        });
    }

    function updateCreditValue() {
        if (!creditTiers.length) {
            console.error("🚨 updateCreditValue called before creditTiers loaded!");
            return 0;
        }

        let totalCredit = 0;
        let breakdownHtml = "";
        let anyInput = false;

        creditTiers.forEach(tier => {
            const input = document.getElementById(tier.id);
            const count = parseInt(input?.value || "0");
            const unitValue = tier.unit_value;

            // 🔥 Keep cart state updated with credit quantities
            cartState.credits[tier.id] = count.toString();

            if (count > 0) {
                anyInput = true;
                const lineTotal = count * unitValue;

                breakdownHtml += `
                    <p class="credit-breakdown-line">
                    <span class="tier-emoji">${tier.emoji}</span>
                    <span class="tier-label">${tier.label}</span>
                    <span class="math-line">→ ${count} × $${unitValue.toFixed(2)} = <strong>$${lineTotal.toFixed(2)}</strong></span>
                    </p>
                `;

                totalCredit += lineTotal;
            }
        });

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

    function updateCreditInputsFromCartState() {
        if (!creditTiers.length) {
            console.error("🚨 updateCreditInputsFromCartState called BEFORE creditTiers loaded! This will break summary updates. Make sure loadCreditTiers() finishes before restoring cart.");
            return;
        }

        creditTiers.forEach(tier => {
            const el = document.getElementById(tier.id);
            if (el) {
                el.value = cartState.credits[tier.id] || "0";
            }
        });

        updateCreditValue();
    }

  //#endregion

  //#region funciton to open and close the checkout modal and make it operational modal Control & Discount Logic
    async function openCheckoutModal() {
        if (!locksAcquired) {
            const locked = await lockSelectedLocationsForCurrentUser();
            if (!locked) {
            showToast("❌ Checkout canceled: could not lock all items.", "error");
            return; // 🚫 don't open modal if locking failed
            }
        }
        
        const modal = document.getElementById("checkout-modal");
        const container = document.getElementById("checkout-items-container");
        const generalDiscountInput = document.getElementById("general-discount");
        const finalTotalEl = document.getElementById("checkout-final-price");

        const cart = checkoutModule.getCart();
        container.innerHTML = "";

        if (cart.length === 0) {
            container.innerHTML = "<p class='cart-empty'>🕳️ Cart is empty</p>";
            finalTotalEl.textContent = "$0.00";

            const checkoutSummaryEl = document.getElementById("checkout-summary-display");
            if (checkoutSummaryEl) {
            checkoutSummaryEl.innerHTML = "";
            checkoutSummaryEl.classList.add("hidden");
            }

            const checkoutBreakdownEl = document.getElementById("checkout-credit-breakdown");
            if (checkoutBreakdownEl) {
            checkoutBreakdownEl.innerHTML = "";
            checkoutBreakdownEl.classList.add("hidden");
            }

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

        // ✅ Updated quantity control handlers with per-location available_qty limit
        container.querySelectorAll(".qty-increase").forEach(btn => {
            btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const target = cart.find(i => i.item_id === id);
            if (target) {
                const maxQty = target.available_qty || 0;
                if (maxQty > 0 && target.qty < maxQty) {
                target.qty += 1;
                } else {
                showToast(`❌ Cannot add more than ${maxQty} at the selected location for ${target.title}`, "error");
                }
                updateCartUI();
                saveCartToStorage();
                renderCartItems();
                openCheckoutModal();
            }
            });
        });

        container.querySelectorAll(".qty-decrease").forEach(btn => {
            btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const targetIndex = cart.findIndex(i => i.item_id === id);

            if (targetIndex !== -1) {
                const target = cart[targetIndex];
                if (target.qty > 1) {
                target.qty -= 1;
                } else {
                cart.splice(targetIndex, 1);
                delete cartState.itemDiscounts[id];
                }
                updateCartUI();
                saveCartToStorage();
                renderCartItems();
                setTimeout(openCheckoutModal, 0);
            }
            });
        });

        const checkoutBreakdownEl = document.getElementById("checkout-credit-breakdown");
        if (checkoutBreakdownEl) {
            const tierLabels = {};
            creditTiers.forEach(tier => {
                tierLabels[tier.id] = {
                    label: tier.label,
                    emoji: tier.emoji,
                    value: tier.unit_value,
                };
            });

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
            saveCartToStorage();
            });
        });

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
            saveCartToStorage();
            });
        });

        updateGeneralDiscountInputFromCartState();
        cartState.items.forEach(item => {
            const saved = cartState.itemDiscounts[item.item_id];
            if (saved) {
            const percentInput = document.querySelector(`.item-discount-input-percent[data-id="${item.item_id}"]`);
            const absoluteInput = document.querySelector(`.item-discount-input-absolute[data-id="${item.item_id}"]`);
            if (percentInput) percentInput.value = saved.percent || "";
            if (absoluteInput) absoluteInput.value = saved.absolute || "";
            }
        });

    
        generalDiscountInput.value = cartState.generalDiscount || "";
        calculateFinalCheckoutTotal();

        const salesIdEl = document.getElementById("sales-id");
        if (salesIdEl) {
            salesIdEl.value = cartState.salesId || ""; // always sync latest salesId, even if blank
        }


        modal.classList.remove("hidden");
        document.body.classList.add("modal-open");
    }

    async function closeCheckoutModal() {
        document.getElementById("checkout-modal").classList.add("hidden");
        document.body.classList.remove("modal-open");
        await unlockSelectedLocationsForCurrentUser();
    }

    //locking the selected locations for other users 
    async function lockSelectedLocationsForCurrentUser() {
    const { data: currentUser, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.user) {
        console.warn("❌ Cannot lock locations: no authenticated user.");
        showToast("❌ Could not lock items: you are not signed in.", "error");
        return false;
    }

    const userId = currentUser.user.id;
    const locksToAcquire = cartState.items
        .filter(item => item.selected_location_id)
        .map(item => item.selected_location_id);

    console.log("🔒 Attempting to lock selected_location_ids:", locksToAcquire);

    let allLocked = true;

    for (const locationId of locksToAcquire) {
        console.log(`🔎 Checking lock status for location ${locationId}`);

        const { data: locData, error: fetchError } = await supabase
        .from("item_stock_locations")
        .select("locked_by")
        .eq("id", locationId)
        .single();

        if (fetchError || !locData) {
        console.error(`❌ Failed to fetch lock status for location ${locationId}:`, fetchError?.message);
        showToast(`❌ Could not check location ${locationId}: ${fetchError?.message || "Unknown error"}`, "error");
        allLocked = false;
        continue;
        }

        if (locData.locked_by) {
        if (locData.locked_by === userId) {
            console.log(`✅ Location ${locationId} is already locked by you. Proceeding.`);
            continue; // ✔️ skip re-locking if already owned
        } else {
            console.warn(`⚠️ Location ${locationId} is locked by another user.`);
            showToast(`⚠️ Location is locked by someone else.`, "warning");
            allLocked = false;
            continue;
        }
        }

        console.log(`🔒 Locking location ${locationId} for user ${userId}`);
        const { error: lockError } = await supabase
        .from("item_stock_locations")
        .update({
            locked_by: userId,
            locked_at: new Date().toISOString()
        })
        .eq("id", locationId);

        if (lockError) {
        console.error(`❌ Failed to lock location ${locationId}:`, lockError.message);
        showToast(`❌ Could not lock location ${locationId}: ${lockError.message}`, "error");
        allLocked = false;
        } else {
        console.log(`✅ Successfully locked location ${locationId}.`);
        showToast(`✅ Locked stock for checkout.`, "success");
        }
    }

    if (allLocked) locksAcquired = true; // 🔐 mark locks as acquired

    return allLocked;
    }

    //unlocking mechanism
    async function unlockSelectedLocationsForCurrentUser() {
        const { data: currentUser, error: userError } = await supabase.auth.getUser();
    if (userError || !currentUser?.user) {
        console.warn("❌ Cannot unlock locations: no authenticated user.");
        return;
    }

    const userId = currentUser.user.id;

    const { error: unlockError } = await supabase
        .from("item_stock_locations")
        .update({
        locked_by: null,
        locked_at: null
        })
        .eq("locked_by", userId);

    if (unlockError) {
        console.error("❌ Failed to unlock locations:", unlockError.message);
    } else {
        console.log("✅ Successfully unlocked all locations locked by this user.");
    }

    locksAcquired = false; // 🔓 reset flag so locks can be acquired again next time
    }

    // === Attach modal listeners
    function setupCheckoutModalListeners() {
        document.getElementById("proceed-checkout-btn")?.addEventListener("click", openCheckoutModal);
        document.getElementById("close-checkout-modal")?.addEventListener("click", closeCheckoutModal);
        document.getElementById("general-discount")?.addEventListener("input", () => {
            calculateFinalCheckoutTotal();
            saveCartToStorage(); // ✅ Save general discount on change
        });

        // ✅ Save Sales ID immediately on input
        document.getElementById("sales-id")?.addEventListener("input", () => {
            saveCartToStorage();
        });

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

        // 🛒 Listen for platform selection
        document.getElementById("platform-select")?.addEventListener("change", (e) => {
            const value = e.target.value;
            if (value === "whatnot") {
                cartState.platformFee = 11.8;
            } else if (value === "ebay") {
                cartState.platformFee = 1;
            } else {
                cartState.platformFee = 0;
            }
            calculateFinalCheckoutTotal();
            saveCartToStorage();
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

            const previewEl = document.getElementById(`discounted-${item.item_id}`);
            if (previewEl) {
                previewEl.textContent = `$${totalAfterItemDiscount.toFixed(2)}`;
            }
        });

        const generalDiscountAmount = (generalDiscountPercent / 100) * subtotalAfterItemDiscounts;

        // 💳 Credits
        let creditValue = 0;
        const creditEl = document.getElementById("credit-value-display");
        if (creditEl) {
            const raw = creditEl.textContent.replace("$", "");
            creditValue = parseFloat(raw) || 0;
        }

        // Calculate subtotal after credits
        const adjustedSubtotal = subtotalBeforeDiscounts - creditValue;
        const denominator = Math.max(adjustedSubtotal, 0.01);

        // ➕ Calculate final total
        const final = subtotalAfterItemDiscounts - generalDiscountAmount - creditValue;
        finalTotalEl.textContent = `$${final.toFixed(2)}`;

        const platformFeeAmount = (cartState.platformFee / 100) * final;
        const storeReceives = final - platformFeeAmount;

        const checkoutSummaryEl = document.getElementById("checkout-summary-display");
        if (checkoutSummaryEl) {
            const balanceLabel = final < 0 ? "Balance Left" : final > 0 ? "Owes Store" : "Settled";
            const colorClass = final < 0 ? "credit-positive" : final > 0 ? "credit-negative" : "credit-neutral";

            // ✅ Calculate effective discount percentage relative to adjusted subtotal (after credits)
            const totalDiscountGiven = perItemDiscountTotal + generalDiscountAmount;
            const discountPercentAfterCredits = (totalDiscountGiven / denominator) * 100;
            const needsFlag = discountPercentAfterCredits > 10;
            cartState.flagged = needsFlag; // ✅ PERSIST FLAG STATE HERE

            const discountColor = needsFlag ? 'red' : '#333';
            const flagText = needsFlag ? ' 🔴 Sale will be flagged' : '';

            checkoutSummaryEl.innerHTML = `
            <div class="checkout-summary-card">
            <p><strong>Subtotal:</strong> $${subtotalBeforeDiscounts.toFixed(2)}</p>

            <p><strong>Credits Applied:</strong> -$${creditValue.toFixed(2)}</p>

            <p><strong>Owes After Credits:</strong> $${adjustedSubtotal.toFixed(2)}</p>

            <p><strong>Per-item Discounts:</strong> -$${perItemDiscountTotal.toFixed(2)}</p>

            <p><strong>General Discount:</strong> -$${generalDiscountAmount.toFixed(2)}</p>

            <p style="margin-top:8px; font-weight:600; color:${discountColor};">
                Effective Discount (post-credits): ${discountPercentAfterCredits.toFixed(1)}%${flagText}
            </p>

            <p class="${colorClass}"><strong>${balanceLabel}:</strong> $${final.toFixed(2)}</p>

            <p><strong>Estimated Store Receives (after ${cartState.platformFee.toFixed(1)}% fee):</strong> $${storeReceives.toFixed(2)} <span class="platform-fee-detail">(-$${platformFeeAmount.toFixed(2)})</span></p>
            </div>
            `;
            checkoutSummaryEl.classList.remove("hidden");
        }
    }

  //#endregion

  //#region logic to be able to preserve the cart even if something changes by accident
    const STORAGE_KEY = "checkout-cart-og";

    function saveCartToStorage() {
        const creditInputs = {};
        creditTiers.forEach(tier => {
            const inputEl = document.getElementById(tier.id);
            creditInputs[tier.id] = inputEl?.value || "0";
        });

        const generalDiscountVal = document.getElementById("general-discount")?.value || "";

        const perItemDiscounts = {};
        cartState.items.forEach(item => {
            const percentInput = document.querySelector(`.item-discount-input-percent[data-id="${item.item_id}"]`);
            const absoluteInput = document.querySelector(`.item-discount-input-absolute[data-id="${item.item_id}"]`);
            perItemDiscounts[item.item_id] = {
                percent: percentInput?.value || "",
                absolute: absoluteInput?.value || "",
            };
        });

        const salesIdVal = document.getElementById("sales-id")?.value || "";
        const platformVal = document.getElementById("platform-select")?.value || "";

        cartState.salesId = salesIdVal;
        cartState.credits = creditInputs;
        cartState.generalDiscount = generalDiscountVal;
        cartState.itemDiscounts = perItemDiscounts;

        const persistedState = {
            ...cartState,
            flagged: cartState.flagged || false,
            platformFee: cartState.platformFee || 0,
            platform: platformVal, // 🔥 Save platform selection
        };

        localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState));
    }

    async function loadCartFromStorage() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return;

        try {
            const parsed = JSON.parse(stored);

            // 🔥 Restore items and always re-sign from the saved stable photo_path
            const rawItems = parsed.items || [];
            const signedItems = await Promise.all(
                rawItems.map(async (item) => {
                    const signedUrl = await resolveImageUrl(item.photo_path || "");
                    return { ...item, image_url: signedUrl }; // keep photo_path intact
                })
            );
            cartState.items = signedItems;

            cartState.credits = parsed.credits || cartState.credits;
            cartState.generalDiscount = parsed.generalDiscount || "";
            cartState.itemDiscounts = parsed.itemDiscounts || {};
            cartState.salesId = parsed.salesId || "";
            cartState.flagged = parsed.flagged || false;
            cartState.platformFee = parsed.platformFee !== undefined ? parsed.platformFee : 0;

            const salesIdEl = document.getElementById("sales-id");
            if (salesIdEl) {
                salesIdEl.value = cartState.salesId || "";
            }

            const platformSelect = document.getElementById("platform-select");
            if (platformSelect && parsed.platform) {
                platformSelect.value = parsed.platform;
            }

            updateCartUI();
            renderCartItems();
            updateCreditInputsFromCartState();
            updateGeneralDiscountInputFromCartState();
            updateCreditValue();

            // ✅ only calculate total if checkout modal elements exist
            if (document.getElementById("checkout-final-price") && document.getElementById("general-discount")) {
                calculateFinalCheckoutTotal();
            }

            signedItems.forEach(item => {
                const card = document.querySelector(`.stock-card [data-id="${item.item_id}"]`)?.closest('.stock-card');
                if (card) card.classList.add("in-cart");
            });

        } catch (e) {
            console.warn("❌ Could not parse or restore stored cart data:", e);
            cartState.items = [];
        }
    }
function clearCart() {
    // 🔥 Build dynamic credits object with 0s for each credit tier
    const dynamicCredits = {};
    creditTiers.forEach(tier => {
        dynamicCredits[tier.id] = "0";
    });

    cartState = {
        items: [],
        credits: dynamicCredits,  // ✅ dynamically generated credits object
        generalDiscount: "",
        itemDiscounts: {},
        platformFee: 0,  // ✅ reset platformFee
        salesId: "",     // ✅ reset salesId
        flagged: false,  // ✅ reset flagged
    };

    localStorage.removeItem(STORAGE_KEY);

    document.querySelectorAll(".select-checkbox").forEach(cb => cb.checked = false);
    document.querySelectorAll(".stock-card.in-cart").forEach(card => card.classList.remove("in-cart"));

    updateCartUI();
    updateCreditInputsFromCartState();
    updateGeneralDiscountInputFromCartState();
    renderCartItems();
    calculateFinalCheckoutTotal();

    const previewSummaryContainer = document.getElementById("cart-preview-summary-display");
    if (previewSummaryContainer) {
        previewSummaryContainer.innerHTML = "";
        previewSummaryContainer.classList.add("hidden");
    }

    const checkoutBreakdownEl = document.getElementById("checkout-credit-breakdown");
    if (checkoutBreakdownEl) {
        checkoutBreakdownEl.innerHTML = "";
        checkoutBreakdownEl.classList.add("hidden");
    }

    // 🔥 Explicitly clear Sales ID and platform inputs
    const salesIdEl = document.getElementById("sales-id");
    if (salesIdEl) salesIdEl.value = "";

    const platformSelect = document.getElementById("platform-select");
    if (platformSelect) platformSelect.value = "";
}


  //#endregion

  //#region logic for confirmation modal
    function setupCheckoutConfirmationModal() {
    const finalizeBtn = document.getElementById("finalize-sale-btn");
    const modal = document.getElementById("password-confirm-modal");
    const title = modal.querySelector(".modal-title");
    const desc = modal.querySelector(".modal-desc");
    const confirmBtn = document.getElementById("confirm-password-btn");
    const cancelBtn = document.getElementById("cancel-password-btn");
    const passwordInput = document.getElementById("password-input");
    const errorMsg = document.getElementById("password-error");

    if (!finalizeBtn || !modal) {
        console.warn("Finalize button or confirmation modal not found!");
        return;
    }

    finalizeBtn.addEventListener("click", () => {
        const cart = checkoutModule.getCart();
        const platformSelectEl = document.getElementById("platform-select");
        const platformVal = platformSelectEl?.value || "";
        const salesIdVal = document.getElementById("sales-id")?.value.trim() || "";

        // ✅ Check cart has items
        if (!cart || cart.length === 0) {
        showToast("❌ Cannot finalize: your cart is empty.", "error");
        return;
        }

        // ✅ Check platform selected and platformFee set
        if (!platformVal || platformVal === "-- Choose Platform --" || cartState.platformFee === 0) {
        showToast("❌ Please select a selling platform before finalizing.", "error");
        return;
        }

        // ✅ Check sales ID filled
        if (!salesIdVal) {
        showToast("❌ Please enter a Sales ID before finalizing.", "error");
        return;
        }

        // ✅ All checks passed → open password modal
        title.innerHTML = `
        <span class="material-icons-outlined" style="vertical-align: middle; font-size: 1.6rem; color: #0071e3; margin-right: 6px;">
            verified
        </span>
        Confirm Checkout
        `;
        desc.textContent = "Please enter your password to finalize and sign this transaction.";

        passwordInput.value = "";
        errorMsg.textContent = "";

        modal.classList.remove("hidden");
        document.body.classList.add("modal-open");

        confirmBtn.onclick = async () => {
        const password = passwordInput.value.trim();
        if (!password) {
            errorMsg.textContent = "Password required.";
            return;
        }
        errorMsg.textContent = "";
        try {
            await finalizeCheckout(password);
            modal.classList.add("hidden");
            document.body.classList.remove("modal-open");
        } catch (err) {
            errorMsg.textContent = "Failed to finalize: " + (err.message || "Unknown error");
        }
        };
    });

    cancelBtn?.addEventListener("click", () => {
        modal.classList.add("hidden");
        document.body.classList.remove("modal-open");
    });
    }

    async function verifyPasswordForCurrentUser(password) {
        const { data, error: userError } = await supabase.auth.getUser();
        if (userError || !data?.user) {
            console.error("❌ Failed to fetch current user:", userError?.message);
            throw new Error("Could not fetch authenticated user.");
        }

        const user = data.user;

        const { error } = await supabase.auth.signInWithPassword({
            email: user.email,
            password,
        });

        if (error) {
            console.error("❌ Password verification failed:", error.message);
            return false; // Incorrect password
        }

        return true; // Password correct
    }

async function finalizeCheckout(password) {
  const loadingOverlay = document.getElementById("loading-overlay");

  try {
    loadingOverlay?.classList.add("active");

    const isValid = await verifyPasswordForCurrentUser(password);
    if (!isValid) throw new Error("Incorrect password. Please try again.");

    const cart = checkoutModule.getCart();
    const { data, error: userError } = await supabase.auth.getUser();
    if (userError || !data?.user) throw new Error("Could not fetch authenticated user.");
    const user = data.user;

    const platform = document.getElementById("platform-select")?.value || "none";
    const salesId = document.getElementById("sales-id")?.value || null;
    const finalTotalText = document.getElementById("checkout-final-price")?.textContent || "$0.00";
    const finalTotal = parseFloat(finalTotalText.replace(/[^0-9.]/g, "")) || 0;

    if (!cartState) throw new Error("Cart state is missing or corrupted.");
    const flagged = !!cartState.flagged;

    // Insert per-item transaction logs
    for (const item of cart) {
      const physicalLocId = item.physical_location_id;
      if (!physicalLocId) throw new Error(`Item "${item.title}" missing location selection.`);

      const txPayload = {
        item_id: item.item_id,
        location_id: physicalLocId,
        quantity: -item.qty,
        action_type: 'checkout',
        confirmed_at: new Date().toISOString(),
        user_id: user.id,
        email: user.email,
        notes: `Sold via ${platform}, Sales ID: ${salesId || 'N/A'}`,
        method: 'checkout',
      };

      const { error: itemTxError } = await supabase.from("stock_transactions").insert(txPayload);
      if (itemTxError) throw new Error(`Failed transaction log: ${item.title} — ${itemTxError.message}`);
    }

    // Calculate credits
    let creditValue = 0;
    const creditEl = document.getElementById("credit-value-display");
    if (creditEl) {
      const raw = creditEl.textContent.replace("$", "");
      creditValue = parseFloat(raw) || 0;
    }

    // Calculate subtotal and discounts
    let subtotalBeforeDiscounts = 0;
    let perItemDiscountTotal = 0;
    const discounts = cartState.itemDiscounts || {};

    const cartDetails = cart.map(item => {
      const qty = item.qty || 1;
      const originalTotal = item.sale_price * qty;

      subtotalBeforeDiscounts += originalTotal;

      const savedDiscount = discounts[item.item_id];
      const percent = savedDiscount ? parseFloat(savedDiscount.percent || "0") || 0 : 0;
      const discountAmount = (percent / 100) * originalTotal;
      perItemDiscountTotal += discountAmount;

      return {
        item_id: item.item_id,
        title: item.title,
        quantity: qty,
        original_total: originalTotal,
        discount_percent: percent,
        discount_amount: discountAmount,
        sale_price: item.sale_price,
        photo_path: item.photo_path || "",
        selected_location_id: item.selected_location_id,
        physical_location_id: item.physical_location_id,
        available_qty: item.available_qty,
      };
    });

    const adjustedSubtotal = subtotalBeforeDiscounts - creditValue;
    const denominator = Math.max(adjustedSubtotal, 0.01);
    const generalDiscountPercent = parseFloat(document.getElementById("general-discount")?.value || "0") || 0;
    const generalDiscountAmount = (generalDiscountPercent / 100) * adjustedSubtotal;
    const totalDiscountGiven = perItemDiscountTotal + generalDiscountAmount;
    const discountPercentAfterCredits = (totalDiscountGiven / denominator) * 100;

    const owesStore = finalTotal;
    const platformFeeAmount = (cartState.platformFee / 100) * owesStore;
    const profitAmount = owesStore - platformFeeAmount;

    const creditsBreakdown = creditTiers.map(tier => {
      const quantity = parseInt(cartState.credits[tier.id] || "0");
      const total = quantity * tier.unit_value;

      return {
        id: tier.id,
        label: tier.label,
        emoji: tier.emoji,
        unit_value: tier.unit_value,
        quantity,
        total,
      };
    });

    // Insert audit
    const auditPayload = {
      external_sales_id: salesId,
      subtotal: subtotalBeforeDiscounts,
      credits_applied: creditValue,
      owes_after_credit: adjustedSubtotal,
      per_item_discount: perItemDiscountTotal,
      general_discount: generalDiscountAmount,
      effective_discount_pct: discountPercentAfterCredits,
      owes_store: owesStore,
      platform_fee_amount: platformFeeAmount,
      platform_fee_percent: cartState.platformFee,
      profit_amount: profitAmount,
      platform: platform,
      cart_snapshot: cartDetails,
      flagged: flagged,
      credits_breakdown: creditsBreakdown,
      notes: `Completed via checkout, flagged=${flagged}`,
      verified_method: 'password',
      verified_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      email: user.email,
      user_id: user.id,
    };

    const { error: auditError } = await supabase.from("sales_audit").insert(auditPayload);
    if (auditError) throw new Error(`Failed audit log: ${auditError.message}`);

    // Insert into sales and get ID
    const salesPayload = {
      external_sales_id: salesId,
      user_id: user.id,
      email: user.email,
      platform: platform,
      subtotal: subtotalBeforeDiscounts,
      credits_applied: creditValue,
      total_discount: totalDiscountGiven,
      final_amount: owesStore,
      platform_fee_amount: platformFeeAmount,
      platform_fee_percent: cartState.platformFee,
      profit_amount: profitAmount,
      flagged: flagged,
      verified_method: 'password',
      verified_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const { data: salesData, error: salesError } = await supabase.from("sales").insert(salesPayload).select("id").single();
    if (salesError) throw new Error(`Failed to record sale: ${salesError.message}`);
    const saleId = salesData.id;

    // Insert sale_items and categories with live category fetch
    for (const item of cart) {
      const qty = item.qty || 1;
      const originalTotal = item.sale_price * qty;
      const savedDiscount = discounts[item.item_id];
      const discountPercent = savedDiscount ? parseFloat(savedDiscount.percent || "0") || 0 : 0;
      const discountAmount = (discountPercent / 100) * originalTotal;
      const finalPrice = (originalTotal - discountAmount);

      const locationId = item.selected_location_id;
      if (!locationId) throw new Error(`Item "${item.title}" missing location selection.`);

      // Fetch remaining stock after sale
      const { data: remainingLoc, error: remErr } = await supabase
        .from("item_stock_locations")
        .select("quantity")
        .eq("id", locationId)
        .single();
      if (remErr) throw new Error(`Failed to fetch remaining stock for ${item.title}: ${remErr.message}`);
      const remainingQty = remainingLoc.quantity;

      // Insert sale_items row
      const saleItemPayload = {
        sale_id: saleId,
        item_id: item.item_id,
        title: item.title,
        quantity: qty,
        sale_price: item.sale_price,
        discount_percent: discountPercent,
        discount_amount: discountAmount,
        final_price: finalPrice,
        remaining_stock_qty: remainingQty,
        location_id: item.physical_location_id,
        photo_path: item.photo_path || "",
      };

      const { data: saleItemData, error: saleItemErr } = await supabase.from("sale_items").insert(saleItemPayload).select("id").single();
      if (saleItemErr) throw new Error(`Failed to record sale item: ${item.title} — ${saleItemErr.message}`);
      const saleItemId = saleItemData.id;

      // 🔎 Fetch categories live from DB
      const { data: itemDetails, error: fetchErr } = await supabase
        .from("item_types")
        .select("categories")
        .eq("id", item.item_id)
        .single();
      if (fetchErr || !itemDetails) throw new Error(`Could not fetch item data for "${item.title}" from server.`);
      const assignedCategories = Array.isArray(itemDetails.categories) ? itemDetails.categories : [];
      for (const category of assignedCategories) {
        const categoryPayload = { sale_item_id: saleItemId, category: category };
        const { error: catErr } = await supabase.from("sale_item_categories").insert(categoryPayload);
        if (catErr) throw new Error(`Failed to record category "${category}" for ${item.title}: ${catErr.message}`);
      }
    }

    // Update stock quantities
    for (const item of cart) {
      const locationId = item.selected_location_id;
      if (!locationId) throw new Error(`Item "${item.title}" missing location selection for stock update.`);

      console.log(`🔄 Decrementing stock at location ${locationId} by ${item.qty} units...`);
      const { error: rpcError } = await supabase.rpc('subtract_quantity', {
        loc_id: locationId,
        delta: item.qty,
      });
      if (rpcError) throw new Error(`Failed stock update: ${item.title} — ${rpcError.message}`);
    }

    const changedItemIds = cart.map(item => item.item_id);
    await bumpInventoryVersion(changedItemIds);

    await unlockSelectedLocationsForCurrentUser();
    checkoutModule.clearCart();

    document.getElementById("checkout-modal")?.classList.add("hidden");
    document.getElementById("password-confirm-modal")?.classList.add("hidden");
    document.body.classList.remove("modal-open");

    showToast(`✅ Checkout complete! Sale finalized${flagged ? ' ⚠️ Flagged for high discount.' : ''}`, "success");

  } catch (err) {
    console.error("❌ Checkout error:", err);
    showToast(`❌ Checkout failed: ${err.message}`, "error");
    throw err;
  } finally {
    loadingOverlay?.classList.remove("active");
  }
}


  //#endregion
   

    function updateGeneralDiscountInputFromCartState() {
    const el = document.getElementById("general-discount");
    if (el) el.value = cartState.generalDiscount || "";
    }

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
    loadCreditTiers,
    setupCreditTierListeners,
    setupCheckoutConfirmationModal,
    verifyPasswordForCurrentUser,
    lockSelectedLocationsForCurrentUser,
    unlockSelectedLocationsForCurrentUser,
    updateCreditInputsFromCartState,
    updateCreditValue
  };
})();
