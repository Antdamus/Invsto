# Favorites Feature Plan (Phase 1 LocalStorage, Phase 2 Supabase-Ready)

Date: 2026-02-16  
Scope: `StoreWebsite/` storefront pages only. Planning document only.

## Decision
The proposed architecture is sound and aligns with the existing storefront layering pattern (`core -> service -> global -> shared UI`), browser-static constraints, and no-framework requirement.

This plan is approved with minor refinements noted below to reduce edge-case risk on `index.html`.

---

## Architecture Summary
- Phase 1 uses `localStorage` only and stores IDs only (`og_favs_v1` contract).
- All favorites reads/writes flow through `window.ogFavService`.
- UI updates are centralized through delegated handlers + `paintStars()` in a shared script.
- All state-changing operations dispatch `og-favs-changed`.
- Page scripts must not include local favorites helpers or direct `localStorage` access.
- Phase 2 readiness is preserved by keeping `syncIfLoggedIn()` and `mergeOnLogin()` as explicit no-op stubs in service layer.

---

## Ownership Trace (Required First Step)

### 1) Where product cards/details are rendered today
- `index` featured cards are static markup hydrated by content/inventory bindings:
  - `StoreWebsite/index.html:298` (`[data-ui="featured-grid"]` cards)
  - `StoreWebsite/index.js:235` (`applyInventoryToSlot`, stamps `data-item-id`)
  - `StoreWebsite/index.js:283` (`applyPublishedContentMap`)
- `catalogue` product cards are generated from a template function:
  - `StoreWebsite/catalogue.js:1021` (`renderCard(p)`)
  - `StoreWebsite/catalogue.js:1084` (`grid.innerHTML = pageItems.map(renderCard).join("")`)
- `item` primary product view is populated from fetched catalog item:
  - `StoreWebsite/item.html:169` (`.item-actions` button cluster)
  - `StoreWebsite/item.js:299` (item lookup in fetched catalog)
  - `StoreWebsite/item.js:317` onward (UI field binding)

### 2) Minimal insertion points for ⭐ markup
- `index`: add a star control to each featured card shell in `StoreWebsite/index.html` and ensure runtime `data-id` propagation from bound inventory ID in `StoreWebsite/index.js` when `data-item-id` is stamped.
- `catalogue`: add star control directly inside `renderCard(p)` output (`StoreWebsite/catalogue.js:1021`) because `p.id` is already available.
- `item`: add one star control in `.item-actions` (`StoreWebsite/item.html:169`) and assign its `data-id` after current item resolve (`StoreWebsite/item.js` in `init()` after `item` is found).

### 3) Repaint viability via DOM contract only
- Repaint model is viable if all star buttons follow:
  - `data-action="toggle-fav"`
  - `data-id="<itemId>"`
- Shared UI can repaint via:
  - `DOMContentLoaded` -> `paintStars()`
  - `window` event `og-favs-changed` -> `paintStars()`
- No page-specific repaint helpers are required.

---

## Structural Risks and Improvements

1. Index featured cards may not always have an inventory-backed ID immediately.
- Risk: star buttons without `data-id` can be clicked before hydration.
- Improvement: disable/hide star buttons until `data-id` exists; shared handler should no-op if missing ID.

2. Event consistency can drift if future edits forget to emit.
- Improvement: only `favorites.service.js` should perform mutations and should always call `emitChanged()` from mutators (`add/remove/toggle`).

3. Future `favorites.html` data fetch can duplicate mapping logic.
- Improvement: in Phase 1, keep fetch mapping minimal and mirror current storefront catalog mapping; in later phase consider shared read-only catalog mapper.

---

## Planned File Structure

Create:

```text
StoreWebsite/Favorites/
  favorites.core.js
  favorites.service.js
  favorites.service.global.js
  favorites.shared.js
StoreWebsite/favorites.html
```

Notes:
- `favorites.core.js`: storage contract and invariants only.
- `favorites.service.js`: public operations + change event + Phase 2 no-op stubs.
- `favorites.service.global.js`: single global bridge (`window.ogFavService`).
- `favorites.shared.js`: delegated click + star repaint only.

---

## Step-By-Step Execution Plan (Implementation Order)

1. Add favorites module folder + core contract.
- Implement storage key `og_favs_v1`.
- Enforce shape `{ v: 1, updatedAt: number, ids: string[] }`.
- Normalize/dedupe IDs and reject invalid values.

2. Add service layer API.
- Wrap core operations with `toggle/add/remove/isFav/getAllIds`.
- Ensure each state mutation emits `og-favs-changed`.
- Add no-op `syncIfLoggedIn()` and `mergeOnLogin()` stubs.

3. Add global bridge.
- Expose stable `window.ogFavService` API only from `favorites.service.global.js`.

4. Add shared UI layer.
- `paintStars()` queries `[data-action="toggle-fav"][data-id]`.
- Delegated click handler calls `window.ogFavService.toggle(id)`.
- Repaint on `DOMContentLoaded` and `og-favs-changed`.

5. Integrate markup + IDs on existing pages.
- `index`: add star controls in featured card shells and propagate item IDs after inventory binding.
- `catalogue`: add star control in `renderCard(p)` template.
- `item`: add star control in CTA row and bind resolved item ID at runtime.

6. Add `favorites.html`.
- Read IDs from `window.ogFavService.getAllIds()`.
- Empty state with link to `catalogue.html`.
- Fetch current catalog data using existing storefront fetch pattern.
- Render cards with image/name/price/stock/view/add-to-cart/star controls.
- Keep cart integration calls limited to existing global hooks only.

7. Add navigation entry points (minimal).
- Add at least one header/nav link to `favorites.html` on storefront pages.

8. Manual QA across pages and tabs/windows.
- Validate toggle, repaint, persistence, and compatibility with cart drawer behavior.

---

## Script Order Requirements

On any page using favorites UI:

1. Existing cart scripts remain unchanged.
2. Load favorites global bridge before favorites shared UI.

Recommended sequence (relative order):

```html
<script type="module" src="./Favorites/favorites.service.global.js"></script>
<script src="./Favorites/favorites.shared.js" defer></script>
```

Then page-specific script (`index.js`, `catalogue.js`, `item.js`) can load normally.

Rule:
- Page scripts must not import favorites modules directly.
- Page scripts must only use `window.ogFavService` (if needed at all).

---

## Manual Verification Checklist

1. Catalogue toggle state
- Toggle star on multiple products.
- Refresh page; states persist.

2. Item page toggle state
- Toggle current item star on `item.html?id=...`.
- Return to catalogue; same item star reflects state.

3. Index featured toggle state
- For inventory-hydrated featured cards, star reflects correct state.
- Cards without resolved ID do not throw errors and do not corrupt storage.

4. Event-driven repaint
- Toggling on one page updates stars after returning/reloading.
- In same page session, all visible star buttons repaint immediately after toggle.

5. Favorites page rendering
- Empty state appears when no IDs.
- Non-empty state renders only existing inventory matches.
- View link routes to `item.html?id=...`.
- Add-to-cart uses existing cart globals and opens/updates drawer badge if available.

6. Storage contract integrity
- `localStorage["og_favs_v1"]` remains versioned, deduped, IDs-only payload.
- No product objects are stored.

7. Non-regression checks
- Cart drawer and cart badge still behave exactly as before.
- No page accesses favorites via direct `localStorage`.

---

## Phase 2 Note (Explicit)
Phase 2 will implement real Supabase member sync by filling `syncIfLoggedIn()` and `mergeOnLogin()` in `favorites.service.js` without changing page-level favorites UI contract (`window.ogFavService` + `og-favs-changed`).

