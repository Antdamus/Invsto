# Cart Consolidation Tests (Pre-Flight + Post-Change)

Scope: StoreWebsite only. This checklist verifies current behavior before consolidation and validates each step (1–7) after changes.

## Pre-Flight Baseline Tests (Before Any Changes)
Run these to confirm existing behavior and capture expected UI/UX.

1. Add-to-cart from catalogue card
- Pass: Item adds to cart, drawer opens, badge increases.
- Fail: No add, drawer does not open, or badge does not update.

2. Add-to-cart from quickview modal
- Pass: Item adds to cart, drawer opens, badge increases.
- Fail: No add, drawer does not open, or badge does not update.

3. Add-to-cart from item page
- Pass: Item adds to cart, drawer opens, badge increases.
- Fail: No add, drawer does not open, or badge does not update.

4. Drawer opens and renders correctly
- Pass: Drawer opens, shows line items, subtotal, and lock info.
- Fail: Drawer fails to open or content is missing.

5. Badge updates after add/remove
- Pass: Badge count reflects current cart quantity.
- Fail: Badge stays stale or disappears incorrectly.

6. Cart page qty inc/dec/remove/clear works
- Pass: Each control updates cart and UI correctly.
- Fail: Quantity or UI does not update.

7. Price lock behavior
- Pass: Qty changes do NOT reset lock; expired locks refresh.
- Fail: Lock resets on qty changes or never refreshes.

## Post-Step Checks (Step 1–Step 7)

### Step 1 — Add `cart.service` bridge
Files affected: `StoreWebsite/StoreCart/cart.service.global.js` and page HTML script order.

Checks:
- Pass: `window.ogCartService` exists in console on index, catalogue, item, and cart pages.
- Pass: No console errors about missing modules or undefined `ogCartService`.
- Fail: `ogCartService` undefined or console shows load-order errors.

### Step 2 — Replace add-to-cart in `StoreWebsite/index.js`
Checks:
- Pass: Add-to-cart on `StoreWebsite/index.html` works as before.
- Pass: Drawer opens after add and badge updates.
- Fail: Add does nothing or throws console errors.

### Step 3 — Replace add-to-cart in `StoreWebsite/catalogue.js`
Checks:
- Pass: Catalogue card add-to-cart works.
- Pass: Quickview modal add-to-cart works.
- Pass: Drawer opens and badge updates.
- Fail: Add does nothing, drawer fails to open, or badge stays stale.

### Step 4 — Replace add-to-cart in `StoreWebsite/item.js`
Checks:
- Pass: Add-to-cart on item page works.
- Pass: Drawer opens and badge updates.
- Fail: Add does nothing or throws console errors.

### Step 5 — Consolidate `StoreWebsite/StoreCart/cart.js`
Checks:
- Pass: Cart page renders line items and totals.
- Pass: Qty inc/dec/remove/clear work and UI refreshes.
- Pass: Price lock countdown displays and updates.
- Fail: Cart page errors, actions do nothing, or countdown breaks.

### Step 6 — Remove duplicated helpers from page scripts
Checks:
- Pass: No references remain to removed helpers (manual spot-check or grep).
- Pass: Add-to-cart flows still work on all pages.
- Fail: Console errors for missing functions.

### Step 7 — Verify drawer + badge integration
Checks:
- Pass: `window.ogCartDrawerOpen` opens drawer from all pages.
- Pass: `window.ogCartBadgeRefresh` updates badges after add/remove.
- Fail: Drawer/badges fail or throw console errors.

## Manual Test Cases (Concrete)

1. Add-to-cart from catalogue card
- Open `StoreWebsite/catalogue.html`.
- Click a card "Add to Cart" button.
- Pass: Drawer opens, item appears, badge increments by 1.

2. Add-to-cart from quickview modal
- Open quickview and click "Add to Cart" in modal.
- Pass: Drawer opens, item appears, badge increments by 1.

3. Add-to-cart from item page
- Open `StoreWebsite/item.html` with a valid item.
- Click "Add to Cart".
- Pass: Drawer opens, item appears, badge increments by 1.

4. Drawer opens and renders correctly
- Click cart icon or "View Cart".
- Pass: Drawer opens and renders list, subtotal, and lock info.

5. Badge updates after add/remove
- Add an item, observe badge increment.
- Remove item in drawer or cart page, observe badge decrement.
- Pass: Badge matches cart qty.

6. Cart page qty inc/dec/remove/clear works
- Open `StoreWebsite/StoreCart/cart.html`.
- Use +/−, remove, and clear buttons.
- Pass: UI and localStorage update immediately.

7. Price lock behavior
- On cart page, adjust quantity for a line item.
- Pass: Lock timestamp does NOT reset on qty change.
- Wait for expiration (or simulate by editing timestamps in localStorage).
- Pass: On refresh, lock is renewed for available items.

## DevTools Checks

1. Console errors
- Pass: No errors for missing globals, module load order, or undefined functions.
- Fail: Errors referencing `ogCartService`, `ogCartDrawerOpen`, or `ogCartBadgeRefresh`.

2. localStorage `og_cart_v1` integrity
- Pass: `og_cart_v1` exists, JSON parses, `version` is correct, `items` array valid.
- Fail: Missing key, invalid JSON, or schema mismatch.

3. Network calls for lock refresh
- Pass: `storefront-catalog` is called when locks expire or refresh is triggered.
- Fail: No network call on lock refresh or repeated failures (4xx/5xx).
