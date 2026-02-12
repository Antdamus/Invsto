# StoreWebsite Audit (Cart Consolidation Support)

## HTML Pages (purpose)
- `StoreWebsite/index.html` — Storefront landing page with featured sections, quickview modal, cart drawer markup, and member access UI.
- `StoreWebsite/catalogue.html` — Product catalogue with filters, quickview modal, cart drawer markup, and member access UI.
- `StoreWebsite/item.html` — Product detail page with add-to-cart buttons, cart drawer markup, and account UI.
- `StoreWebsite/StoreCart/cart.html` — Full cart page with line-item list, quantity controls, and order summary.
- `StoreWebsite/access.html` — Member access (magic link) sign-in page.
- `StoreWebsite/join.html` — Join/alerts signup page (magic link flow + consent).
- `StoreWebsite/profile.html` — Member profile page with preferences and VIP modal.
- `StoreWebsite/admin-storefront.html` — Storefront page with admin-only editing panel and slot controls.
- `StoreWebsite/StoreAdmin/index.html` — Admin login gate with Supabase auth + role check.
- `StoreWebsite/StoreAdmin/store-admin.html` — Empty file (0 bytes).

## JavaScript Files (responsibilities)
- `StoreWebsite/index.js` — Storefront UI interactions, quickview modal, search/backdrop, and cart helper logic (localStorage cart + add-to-cart).
- `StoreWebsite/catalogue.js` — Catalogue filters/search/sort/rendering, quickview modal, auth UI, and cart helper logic (localStorage cart + add-to-cart).
- `StoreWebsite/item.js` — Product detail fetch/render, related items, add-to-cart logic, nav drawer, and auth UI.
- `StoreWebsite/StoreCart/cart.js` — Cart page rendering, inventory hydration via Edge Function, qty controls, remove/clear, price-lock refresh and countdown.
- `StoreWebsite/StoreCart/cart.core.js` — Cart contract, storage, normalization, price locks, and utility functions (exported).
- `StoreWebsite/StoreCart/cart.service.js` — Cart service API (add/update/remove, badge count, price lock refresh, totals) built on `cart.core.js`.
- `StoreWebsite/StoreCart/cart.drawer.js` — Mini cart drawer UI, read/write cart in localStorage, refresh price locks, and drawer open/close API.
- `StoreWebsite/StoreCart/cart.shared.js` — Cart badge updater tied to localStorage and `window.ogCartBadgeRefresh`.
- `StoreWebsite/access.js` — Member access flow (magic link request via Edge Function), cooldown, and Supabase readiness gating.
- `StoreWebsite/join.js` — Join/signup flow (magic link via Edge Function), consent handling, cooldown, and Supabase readiness gating.
- `StoreWebsite/profile.js` — Member profile UI; reads/writes `members` in Supabase; prefs and VIP modal logic.
- `StoreWebsite/admin-storefront.js` — Admin editing UI for storefront slots, draft/publish flow, and inventory binding via Edge Function + Supabase table writes.
- `StoreWebsite/initSupabase.js` — Supabase client initializer for public site pages (sets globals, fires `supabase-ready`).
- `StoreWebsite/StoreAdmin/index.js` — Admin login, session/role checks, and redirect to admin storefront.
- `StoreWebsite/StoreAdmin/initSupabase.js` — Supabase client initializer for admin pages (same behavior as root `initSupabase.js`).

## Cart Logic Locations (file + function names)
- `StoreWebsite/index.js` — `getCart`, `setCart`, `makePriceLock`, `upsertCartItem`, `openCartDrawerSoft`, plus `onClick` handler with `data-action="add-to-cart"`.
- `StoreWebsite/catalogue.js` — `getCart`, `setCart`, `makePriceLock`, `upsertCartItem`, `openCartDrawerSoft`, plus `wireGlobalClicks` handler with `data-action="add-to-cart"`.
- `StoreWebsite/item.js` — `getCart`, `setCart`, `makePriceLock`, `upsertCartItem`, plus `bindActions` handler with `data-action="add-to-cart"`.
- `StoreWebsite/StoreCart/cart.core.js` — `createEmptyCart`, `loadCart`, `saveCart`, `createPriceLock`, `isPriceLockExpired`, `normalizeCart`, `getCartQuantity`, `clearCart`.
- `StoreWebsite/StoreCart/cart.service.js` — `addToCart`, `setCartQty`, `removeFromCart`, `getCart`, `getCartBadgeCount`, `refreshExpiredPriceLocks`, `computeCartTotals`.
- `StoreWebsite/StoreCart/cart.js` — `createEmptyCart`, `normalizeCart`, `loadCart`, `saveCart`, `createPriceLock`, `isLockExpired`, `cartQtySum`, `refreshExpiredLocks`, `render`, `paintBadges`, `setQty`, `incQty`, `removeLine`, `clearCart`, `bindEvents`, `updateCountdownPills`, `tick`.
- `StoreWebsite/StoreCart/cart.drawer.js` — `readCart`, `writeCart`, `refreshExpiredLocksIfNeeded`, `render`, `updateQty`, `removeLine`, plus `window.ogCartDrawerOpen` and `window.ogCartDrawerClose`.
- `StoreWebsite/StoreCart/cart.shared.js` — `readCartQty`, `paintBadges`, `window.ogCartBadgeRefresh`.

## Supabase Initialization and Usage
- Initialization:
  - `StoreWebsite/initSupabase.js` — calls `supabase.createClient`, sets `window.supabase`, `window.supabaseClient`, `window.SUPABASE_URL`, `window.SUPABASE_ANON_KEY`, and dispatches `supabase-ready`.
  - `StoreWebsite/StoreAdmin/initSupabase.js` — same initialization logic for admin pages.
- Usage (public site):
  - `StoreWebsite/access.js`, `StoreWebsite/join.js`, `StoreWebsite/profile.js`, `StoreWebsite/index.js`, `StoreWebsite/catalogue.js`, `StoreWebsite/item.js` use `window.supabaseClient || window.supabase` and wait for `supabase-ready` to access auth/session or member data.
  - `StoreWebsite/access.js` and `StoreWebsite/join.js` call Edge Function `og_send_magic_link` using `window.SUPABASE_URL`.
  - `StoreWebsite/index.js`, `StoreWebsite/catalogue.js`, `StoreWebsite/item.js`, `StoreWebsite/StoreCart/cart.js`, `StoreWebsite/StoreCart/cart.drawer.js`, `StoreWebsite/admin-storefront.js` fetch inventory via the Edge Function `storefront-catalog` using project URL.
- Usage (admin):
  - `StoreWebsite/StoreAdmin/index.js` uses `window.supabase` auth and queries `public.user_roles`.
  - `StoreWebsite/admin-storefront.js` uses `window.supabase` to read/write `storefront_content` and reads inventory via the Edge Function.

## Cross-File Dependencies (imports and globals)
- `StoreWebsite/StoreCart/cart.service.js` imports `loadCart`, `saveCart`, `normalizeCart`, `createPriceLock`, `isPriceLockExpired`, `getCartQuantity` from `StoreWebsite/StoreCart/cart.core.js`.
- `StoreWebsite/index.html`, `StoreWebsite/catalogue.html`, `StoreWebsite/item.html`, `StoreWebsite/StoreCart/cart.html`, `StoreWebsite/access.html`, `StoreWebsite/join.html`, `StoreWebsite/profile.html`, `StoreWebsite/admin-storefront.html` all include the Supabase UMD script and `StoreWebsite/initSupabase.js` (or `../initSupabase.js` from cart).
- `StoreWebsite/StoreAdmin/index.html` includes `StoreWebsite/StoreAdmin/initSupabase.js` and `StoreWebsite/StoreAdmin/index.js`.
- `StoreWebsite/index.js`, `StoreWebsite/catalogue.js`, `StoreWebsite/item.js` call `window.ogCartDrawerOpen` (provided by `StoreWebsite/StoreCart/cart.drawer.js`).
- `StoreWebsite/StoreCart/cart.drawer.js` calls `window.ogCartBadgeRefresh` (provided by `StoreWebsite/StoreCart/cart.shared.js`).
- `StoreWebsite/StoreCart/cart.drawer.js` depends on `window.OG_CART_DRAWER_CFG` set inline in:
  - `StoreWebsite/index.html`
  - `StoreWebsite/catalogue.html`
  - `StoreWebsite/item.html`
  - `StoreWebsite/StoreCart/cart.html`
- Shared cart storage key: `og_cart_v1` used by `StoreWebsite/index.js`, `StoreWebsite/catalogue.js`, `StoreWebsite/item.js`, `StoreWebsite/StoreCart/cart.js`, `StoreWebsite/StoreCart/cart.drawer.js`, `StoreWebsite/StoreCart/cart.shared.js`, `StoreWebsite/StoreCart/cart.core.js`, `StoreWebsite/StoreCart/cart.service.js`.
- `StoreWebsite/StoreCart/cart.js` reads `window.SUPABASE_URL` set by `StoreWebsite/initSupabase.js`.

## Duplicated or Experimental Files
- Duplicate Supabase initializers: `StoreWebsite/initSupabase.js` and `StoreWebsite/StoreAdmin/initSupabase.js` are identical copies.
- Mermaid documentation/diagrams (non-runtime):
  - `StoreWebsite/catalogue.mmd`
  - `StoreWebsite/catalogue-filterlogic.mmd`
  - `StoreWebsite/spampreventionforjoinandaccess.mmd`
  - `StoreWebsite/sotckcontract.mmd`
- Empty placeholder: `StoreWebsite/StoreAdmin/store-admin.html` (0 bytes).

## Add-to-Cart Entry Points
- Catalogue card button:
  - UI: `StoreWebsite/catalogue.html` card button rendered by `renderCard` in `StoreWebsite/catalogue.js` (button has `data-action="add-to-cart"` and `data-id`).
  - Handler: `wireGlobalClicks` in `StoreWebsite/catalogue.js` → `if (action === "add-to-cart")` → `upsertCartItem(...)`.
- Quickview modal button:
  - UI: `StoreWebsite/catalogue.html` quickview button (`data-ui="qv-add"` + `data-action="add-to-cart"`).
  - Handler: `wireGlobalClicks` in `StoreWebsite/catalogue.js` → `if (action === "add-to-cart")` → `upsertCartItem(...)`.
  - Note: `openQuickview` in `StoreWebsite/catalogue.js` sets `qvAdd.dataset.id` for the same handler.
- Item page button:
  - UI: `StoreWebsite/item.html` button with `data-action="add-to-cart"`.
  - Handler: `bindActions` in `StoreWebsite/item.js` → `if (action === "add-to-cart")` → `upsertCartItem(...)`.
- Cart page update/remove controls:
  - UI: `StoreWebsite/StoreCart/cart.html` line items rendered by `StoreWebsite/StoreCart/cart.js` include buttons with `data-action="remove"`, `data-action="inc"`, `data-action="dec"`, plus the qty input.
  - Handler: `bindEvents` in `StoreWebsite/StoreCart/cart.js` → uses `removeLine`, `incQty`, `setQty`.

## StoreCart Module API (public functions)
- `StoreWebsite/StoreCart/cart.core.js` (ES module exports):
  - `CART_STORAGE_KEY` — storage key constant.
  - `CART_VERSION` — cart schema version.
  - `PRICE_LOCK_MS` — lock duration constant.
  - `createEmptyCart()` — returns empty cart structure.
  - `loadCart()` — read/validate cart from localStorage.
  - `saveCart(cart)` — normalize and persist cart.
  - `createPriceLock(price)` — creates price lock timestamps.
  - `isPriceLockExpired(cartLine)` — checks lock expiry.
  - `normalizeCart(cart)` — enforces invariants, de-dupes lines.
  - `getCartQuantity(cart)` — sums quantities.
  - `clearCart()` — removes cart from storage and returns empty cart.
- `StoreWebsite/StoreCart/cart.service.js` (ES module exports):
  - `addToCart(id, qtyDelta, currentPrice)` — add/increment line and reset price lock.
  - `setCartQty(id, qty)` — set absolute quantity.
  - `removeFromCart(id)` — remove a cart line.
  - `getCart()` — read normalized cart.
  - `getCartBadgeCount()` — summed quantity badge.
  - `refreshExpiredPriceLocks(resolveItem)` — refresh locks via resolver.
  - `computeCartTotals(resolveExists)` — compute subtotal/qty excluding unavailable items.
- `StoreWebsite/StoreCart/cart.drawer.js` (global API):
  - `window.ogCartDrawerOpen()` — opens drawer and renders contents.
  - `window.ogCartDrawerClose()` — closes drawer.
- `StoreWebsite/StoreCart/cart.shared.js` (global API):
  - `window.ogCartBadgeRefresh()` — repaint cart count badges.
- `StoreWebsite/StoreCart/cart.js`:
  - No public exports; runs on `DOMContentLoaded` and manages cart page UI internally.
