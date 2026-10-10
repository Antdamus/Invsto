# Deferred inventory pricing

Add Item defaults to **Send to pricing queue**. Staff enter item facts, photos, supplier information and any stock placement; all financial fields remain null. The initial default owner is the unique active employee named Otello Guillen. Staff may choose another active employee for the item, or choose **Set prices now** to use the existing intake pricing controls.

**Pricing** is a dedicated navigation page, separate from Tasks. Assigned to me is the default scope. Everyone shows the full queue. To price, Skipped and Priced separate unfinished work from deferred items and completed pricing. The queue is ordered oldest first, with server pagination and barcode/title search. The selected item shows photos, descriptive information, source, location and entry date. On phones the queue becomes an item selector; the card remains the focus.

The owner (or an administrator) sets cost, retail and optionally a minimum selling price. Save & next atomically saves prices, records the actor and time, invalidates inventory caches, and advances. Skip for now changes no prices; it persists in Skipped. Typed amounts remain in the current page when changing cards or retrying a failed save. Leaving the page with unsaved amounts prompts the user. Skipping does not save draft amounts to the server.

Administrators can reassign a pending item and change the default owner for future intake. These actions do not generate generic tasks or task notifications. The page refreshes counts every minute while visible without replacing the card being edited.

Migration `20261010140000_inventory_pricing_queue.sql` must be applied before publishing the frontend. It adds the queue fields, protected settings, read/action RPCs and append-only pricing events. Item insertion and initial assignment are one transaction; an unavailable owner fails the entire insert. Existing inventory is unchanged. Pending costs, retail, minimum and per-weight prices must all be null, and eBay sync is held off. Pricing restores only the eBay preparation flag originally selected during intake; normal publishing checks still apply. Storefront publication is blocked until pricing is complete.

The action RPC locks the item and checks its revision, active employee access, ownership, amount validity, deletion state and pending status. A second or stale submission cannot overwrite the completed price. Completed prices remain in ordinary inventory history and in the queue's Priced records.

Validation: `node --test tests/inventory-pricing-database.test.mjs tests/inventory-prices-ebay.test.mjs`. Database tests run against isolated PGlite, never live stock. Browser verification uses synthetic inventory to exercise intake, save/next, skip/revisit and responsive layouts. Live verification checks configuration, page loading and the empty queue without adding test stock.
