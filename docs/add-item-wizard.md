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
