# Shared material costs

Open **Material costs** from Stock, the Pricing queue, or the live report's Cost studio.
The initial acquisition-cost rates are 10K gold $78/g, 14K gold $99/g, and sterling silver (925) $5.80/g.
These rates are separate from `metal_spot_prices`, which drives storefront retail pricing.

Inventory staff can read rates; administrators can update them. Other gold purities are optional.
Unknown gold purity assumes 10K and unknown silver purity assumes 925 when material is known.
Live report titles with one clear positive gram weight and no specified material default to sterling silver 925. The item is labeled **Silver 925 assumed**, uses the shared silver rate (or show override), and updates buyer profit and loss totals. Explicit materials, unsupported purities, ambiguous weights, plated items, and saved manual or material overrides retain their existing treatment.
Unsupported purities, plated items, watches, coins, or missing weights require individual costs.

- Add Item uses shared rates with **Set prices now** and **Use shared material cost**. Editing cost or cost per gram selects a custom cost. Saved drafts preserve that choice. New globally priced items are rejected if their rate became stale before saving.
- Deferred intake keeps all prices blank. Its assigned owner can choose **Use shared cost** in the Pricing queue. The server checks both the item revision and rate revision before pricing.
- Live reports inherit global rates. A show rate overrides its global default; clearing it restores inheritance. Manual item costs take priority, including deliberate zero. Rates are current estimates and refresh with the live report; exported PDFs preserve the rates at export.
- **Also update eligible stock costs** requires a fresh preview. Eligibility means current positive stock, ready pricing, known supported material and grams, no manual-cost flag, and saved cost equal to rounded grams × saved cost per gram. Older qualifying weight-based items can be enrolled. Preview shows per-unit changes and totals adjusted for quantity; the first 100 records are listed, with all eligible records included in totals and the update.
- Applying stock changes updates cost and cost per gram only. Retail prices, minimum prices, completed sale records, sold-out stock and unpriced inventory are untouched. Direct edits to a linked item's cost, rate, weight, or material disconnect it from bulk material updates.
- Updates are atomic, checked against a preview fingerprint and rate timestamp, recorded in `material_cost_events`, and invalidate the inventory cache. A short table lock prevents stock movements from changing the reviewed set during application.

Migration: `20261029210000_shared_material_costs.sql`.
Validation: `node --test tests/material-costs.test.mjs tests/live-sales-report.test.mjs tests/live-sales-report-database.test.mjs tests/inventory-pricing-database.test.mjs`.
