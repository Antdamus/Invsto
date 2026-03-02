# StoreWebsite Stabilization Plan (Pre-Cart Consolidation)

Date: 2026-02-12
Scope: `StoreWebsite/` only. No framework rewrites; keep browser-static compatibility.

This plan is a technical diagnosis plus a prioritized stabilization roadmap to unblock and de-risk Cart Consolidation Steps 2–7.

## Executive Summary
- Step 1 (browser-static `window.ogCartService` bridge) is already implemented and working on index/catalogue/item/cart.
- The cart consolidation plan (Steps 2–7) remains valid, but a small **pre-step stabilization block** is required to fix broken script paths, invalid document structure, and navigation issues that will otherwise mask cart regressions during consolidation testing.
- Primary critical risk is on `StoreWebsite/item.html` (invalid markup + broken cart drawer resources), which makes drawer and badge behavior unreliable and could fail Step 4 tests even if cart logic is correct.

---

## Findings (By Severity)

### 🔴 Critical (must fix before continuing cart consolidation)
1. **Invalid `item.html` document structure and broken cart drawer asset paths**
   - `StoreWebsite/item.html` loads scripts **before `<!DOCTYPE html>`** and outside `<html>`, which can trigger quirks mode and unpredictable layout/script order.
   - `StoreWebsite/item.html` references `cart.drawer.css` and `cart.drawer.js` **without the `StoreCart/` path**, causing 404s and leaving `window.ogCartDrawerOpen` undefined.
   - `StoreWebsite/item.html` does **not load `StoreWebsite/StoreCart/cart.shared.js`**, so badge updates never occur on the item page.
   - Impact: Step 4 tests (item add-to-cart + drawer/badge) will fail for reasons unrelated to `ogCartService`.
   - Files: `StoreWebsite/item.html`, `StoreWebsite/StoreCart/cart.drawer.js`, `StoreWebsite/StoreCart/cart.shared.js`.

2. **Broken navigation anchor targets to non-existent sections**
   - `StoreWebsite/item.html` and `StoreWebsite/StoreCart/cart.html` link to `index.html#contact`, but `#contact` does not exist in `StoreWebsite/index.html`.
   - Impact: broken navigation creates user confusion and makes test navigation unreliable.
   - Files: `StoreWebsite/item.html`, `StoreWebsite/StoreCart/cart.html`, `StoreWebsite/index.html`.

### 🟠 Medium (fix during consolidation)
1. **Broken navigation paths to missing pages**
   - `shop.html` is referenced but does not exist.
   - Several footer links (e.g., `shipping.html`, `returns.html`, `care.html`, `contact.html`, `privacy.html`, `terms.html`) do not exist in `StoreWebsite/`.
   - Files: `StoreWebsite/catalogue.html`, `StoreWebsite/access.html`, `StoreWebsite/join.html`, `StoreWebsite/profile.html`.

2. **Cart drawer item links break on the cart page**
   - `StoreWebsite/StoreCart/cart.drawer.js` renders links as `item.html?id=...` (relative).
   - When the drawer is used on `StoreWebsite/StoreCart/cart.html`, this points to `StoreWebsite/StoreCart/item.html` (missing).
   - Files: `StoreWebsite/StoreCart/cart.drawer.js`, `StoreWebsite/StoreCart/cart.html`.

3. **Index quickview add-to-cart can silently no-op**
   - `StoreWebsite/index.js` add-to-cart relies on `activeQuickviewId`. If inventory hydration fails or cards are missing `data-item-id`, the add-to-cart handler returns without feedback.
   - Impact: “Add to cart” appears to work but doesn’t change cart; this is easily misread as a consolidation regression.
   - Files: `StoreWebsite/index.js`.

4. **Supabase URL/config drift across files**
   - Hardcoded URLs in `StoreWebsite/catalogue.js` and `StoreWebsite/item.js`, while other files use `window.SUPABASE_URL` or `window.OG_CART_DRAWER_CFG`.
   - Impact: environment drift if project URL changes or if staging/prod differ.
   - Files: `StoreWebsite/catalogue.js`, `StoreWebsite/item.js`, `StoreWebsite/index.js`, `StoreWebsite/StoreCart/cart.js`, `StoreWebsite/admin-storefront.js`, `StoreWebsite/StoreCart/cart.drawer.js`.

### 🟡 Low (cleanup / tech debt)
1. **Dead or unused code**
   - `openCartDrawerSoft()` unused in `StoreWebsite/index.js` and `StoreWebsite/catalogue.js`.
   - `itemHrefFor()` unused in `StoreWebsite/StoreCart/cart.drawer.js`.
   - `StoreWebsite/StoreAdmin/store-admin.html` is an empty 0-byte placeholder.

2. **Global namespace risk (low)**
   - `StoreWebsite/index.js` runs in the global scope and defines `$`, `$$`, and other helpers globally. This can collide with future libs.

3. **Silent failure patterns**
   - Inventory hydration errors are swallowed in `StoreWebsite/index.js`, meaning add-to-cart can fail without feedback.
   - Best handled with lightweight user feedback rather than console-only errors.

---

## Cart Consolidation Plan (Steps 2–7) Evaluation

**Is the remaining plan still valid?** Yes. The core migration (Steps 2–7) remains correct and safe.

**Should step order change?** No, but **insert a stabilization gate before Step 2** to fix broken script paths, `item.html` document structure, and navigation issues that would otherwise mask or mimic cart regressions.

**Should any additional step be inserted before Step 2?** Yes:
- **Stabilization Step 0**: Fix `item.html` structure and cart drawer/badge wiring; correct navigation anchors/paths that break test flows.

---

## Revised Stabilization Roadmap (Prioritized)

### A) Bug Fixes (stabilization before Step 2)
1. **Fix `item.html` structure and cart drawer wiring**
   - Move Supabase scripts into `<head>` and ensure `<!DOCTYPE html>` is first.
   - Fix paths to `StoreWebsite/StoreCart/cart.drawer.css` and `StoreWebsite/StoreCart/cart.drawer.js`.
   - Add `StoreWebsite/StoreCart/cart.shared.js` to `item.html` so badge updates work.
   - Files: `StoreWebsite/item.html`.

2. **Fix broken navigation anchors**
   - Either add `id="contact"` section to `StoreWebsite/index.html` or update links that reference it.
   - Files: `StoreWebsite/index.html`, `StoreWebsite/item.html`, `StoreWebsite/StoreCart/cart.html`.

3. **Fix cart drawer product links when used from `StoreCart/cart.html`**
   - Make drawer link aware of base path or use an absolute/relative path that works from `StoreWebsite/StoreCart/`.
   - Files: `StoreWebsite/StoreCart/cart.drawer.js`, `StoreWebsite/StoreCart/cart.html`.

### B) Structural Refactor (during consolidation)
1. **Supabase config normalization (no migration)**
   - Standardize on `window.SUPABASE_URL` (set by `StoreWebsite/initSupabase.js`) for all storefront files.
   - Alternatively, centralize URL + channel into a tiny config module that is loaded before page scripts.
   - Files: `StoreWebsite/catalogue.js`, `StoreWebsite/item.js`, `StoreWebsite/index.js`, `StoreWebsite/StoreCart/cart.js`, `StoreWebsite/admin-storefront.js`, `StoreWebsite/StoreCart/cart.drawer.js`.

2. **Continue cart consolidation Steps 2–7**
   - Replace page-local cart helpers with `window.ogCartService` (Steps 2–4).
   - Consolidate `StoreWebsite/StoreCart/cart.js` (Step 5).
   - Remove duplicated helpers (Step 6).
   - Verify drawer + badge integration (Step 7).

### C) Cleanup (after consolidation)
1. **Remove dead helpers**
   - `StoreWebsite/index.js`: `openCartDrawerSoft()`
   - `StoreWebsite/catalogue.js`: `openCartDrawerSoft()`
   - `StoreWebsite/StoreCart/cart.drawer.js`: `itemHrefFor()`

2. **Fix or remove broken footer links**
   - Replace `shop.html` with `catalogue.html` (and query params if needed).
   - Remove or stub missing legal/support pages (or add placeholders if intended).
   - Files: `StoreWebsite/catalogue.html`, `StoreWebsite/access.html`, `StoreWebsite/join.html`, `StoreWebsite/profile.html`.

---

## Recommended Execution Sequence

1. **Stabilization Step 0 — Critical wiring fixes**
   - Fix `StoreWebsite/item.html` structure and cart drawer assets.
   - Fix `#contact` anchor links.
   - Fix cart drawer product links from `StoreWebsite/StoreCart/cart.html`.

2. **Cart Consolidation Step 2** — `StoreWebsite/index.js` add-to-cart via `window.ogCartService`.

3. **Cart Consolidation Step 3** — `StoreWebsite/catalogue.js` add-to-cart via `window.ogCartService`.

4. **Cart Consolidation Step 4** — `StoreWebsite/item.js` add-to-cart via `window.ogCartService`.

5. **Cart Consolidation Step 5** — `StoreWebsite/StoreCart/cart.js` consolidation with `cart.core`/`cart.service`.

6. **Cart Consolidation Step 6** — remove duplicated cart helpers.

7. **Cart Consolidation Step 7** — verify drawer + badge integration across pages.

8. **Medium/Low Cleanup** — navigation links, supabase config normalization, dead code removal.

---

## Notes / Non-Goals
- No framework rewrite or architectural migration is required.
- All recommendations are incremental and keep browser-static compatibility.
- This plan assumes the current `og_cart_v1` contract and 15-minute price lock behavior remain unchanged.

