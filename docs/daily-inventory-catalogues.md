# Manny's eBay catalogue

Open **Stock → Manny · eBay catalogue** (also on Client catalogues).

1. Choose the day the new inventory items were created, in America/New_York time.
2. Click **Gather all items**. Every active item type created during that Eastern calendar day is included once, without a page or 100-item limit. Restocking existing item types does not count as a new item.
3. Review photos, retail prices, titles, descriptions and references. Missing prices/photos remain visible in the draft and block publication until fixed and gathered again.
4. **Publish share link**, then copy the link for Manny. **Print / Save PDF** prints the same selection with an index and item navigation, without staff controls.

The selected date persists in the saved draft and its dated URL. Reopen the date and gather again in the morning to pick up late additions. A published catalogue is a snapshot of the last published draft; gathering or editing stock never silently adds items to that published copy. Publish again to update the same link. Turn link off revokes access. Deleted items and removed photos are withdrawn from the public view.

Share links use `https://www.og-jewelers.com/representative-catalogue?share=TOKEN`. The branded public shell is generated with `node tools/build-daily-catalogue.mjs` and deployed to the storefront's `initialaunch` branch using only `StoreWebsite/representative-catalogue.html`. It loads the versioned shared assets from JoinPage, contains no staff controls, and never loads staff authentication. Existing GitHub links still work. Both views use the same full-screen photo viewer as the private client catalogue, including pinch/wheel zoom, drag, thumbnails, Fit and keyboard controls. The featured photograph also opens the viewer.

The public page is a read-only representative review. It has no shopping/cart or order submission. The service endpoint strictly allows photos, retail prices, descriptions, item references, material, purity and weight. Costs, minimum prices, suppliers, quantities, notes and staff identities are excluded. The public endpoint cannot resolve draft tokens. Shared images use expiring links refreshed while the page is open.

Implementation: `inventory-daily-catalogue.*`, `inventory_daily_catalogues` table and its three RPCs, and `storefront-catalog?daily_catalogue=TOKEN`. Public links use `?share=TOKEN` so index anchors preserve access; the page sets `no-referrer` and `noindex,nofollow`. Only inventory staff can prepare/publish. Existing customer catalogue APIs and workflows are unchanged.

Checks: `node --test tests/daily-catalogue.test.mjs tests/daily-catalogue-ui.test.mjs tests/inventory-catalogues.test.mjs tests/catalogue-requests.test.mjs`.
