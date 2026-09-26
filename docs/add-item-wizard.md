# Add Item steps and watch intake

The form shows Information, Photos, Description, Pricing, Labels, Stock, Marketplace, and Review one at a time. Back and previously visited steps preserve the fields and selected photos. Next validates the current step; Add Item validates all steps and opens the first field that needs attention. Enter on an earlier step advances without saving.

Watch mode records a name, optional model/reference, component materials, and modifications in `item_types.watch_details`. The saved description includes those details so existing inventory and storefront views can display them. Watches do not inherit the jewelry metal, purity, or price per weight. Weight is optional; cost and sale price are entered directly. Jewelry keeps its existing cost calculation. Drafts retain the mode, fields, costing choice, and current step.

Weight entry is on Information. Station capture is a separate action on Photos; upload, selection, crop, and background tools still use the existing image pipeline. Watch copy generation accepts a photo and watch name without requiring a single material, purity, or weight.

## Rollout

1. Apply `supabase/migrations/20260925120000_item_watch_details.sql`.
2. Deploy the updated `generate-inventory-copy` Supabase function with `--no-verify-jwt`. Its checked-in configuration also sets `verify_jwt = false`.
3. Publish the HTML, JavaScript, and CSS, including both new `additem-wizard` assets.

Deploy the database column before the frontend so watch inserts can succeed. This change does not deploy these resources automatically.

Wristwatch category 31387 follows [eBay's watch category reference](https://ir.ebaystatic.com/pictures/aw/pics/sc/listing/2020_05_watches_item_specifics.pdf). Watch aspect generation avoids single-metal and unbranded defaults; eBay readiness calls out brand and department for completion in the marketplace listing workflow.

## Verification

Run `npm run test:add-item`. Browser tests load the real form, assisted module, and save handler with mocked database, photo storage, and label services. They cover navigation, validation, watch save payloads, drafts, photo selection, mode changes, and mobile layout. Backend tests exercise the copy endpoint with mocked storage and AI responses. No live inventory, capture station, or printer is used.

## Phone layout

At widths up to 900px, navigation follows the active step in normal document flow. Category and location-type lists expand within the form and scroll independently, with their search field kept visible. Search filters existing values and preserves the entered spelling for a new category. Options are keyboard-operable buttons; Escape closes the list.

Phone fields use 16px text, controls have touch-sized targets, and the page accounts for safe-area insets. The visual viewport supplies dialog/list height limits when a mobile keyboard reduces the available space. Placement dialogs scroll as a whole so their confirmation buttons remain reachable.

The browser suite includes the real role-navigation header, all eight steps at 320px and 390px portrait sizes and 844px landscape, a long category list, category creation/filtering, selected photos and the crop editor, and a simulated keyboard viewport. Run the WebKit mobile checks with `INVSTO_ITEM_BROWSER=webkit node --test --test-name-pattern="phone category|all eight|phone dialogs|photo selection" tests/add-item-wizard.test.mjs`. Physical iPhone keyboard behavior still needs device verification.
