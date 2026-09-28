# Receiving stock for existing items

The default Add Inventory page is a compact receiving flow for one item or a batch going to one destination. It never creates or edits catalog items, prices, watch details or coin specifications.

1. Choose a tray or container by name or camera/barcode scan. Store and parent storage names are shown to distinguish locations. The destination controls collapse after selection and remain selected for the next batch.
2. Scan an existing item barcode or search by title. Barcode acceptance or Enter adds an exact match once; name search requires selecting a result. Duplicate item selections increment that line. Quantities are editable without repeated scans. Removals have Undo.
3. Review the quantities and destination, enter your password once, and save. The success receipt offers optional printing for each item through the existing label/print-station controls. A single-item receipt links back to that Stock item.

The camera supports the same shared barcode/QR scanner as the rest of Invsto. This release adds no camera library or printer-helper change. Mobile controls use native selects and stay in page flow; there is no fixed footer over the entry fields. Destination details and batch notes collapse to save space.

## Drafts and retries

Drafts, the most recent receipt and a pending request ID are stored under a user-specific localStorage key on that browser. Passwords are never persisted. The data does not follow the user to a different phone or browser. A browser storage failure blocks stock submission when the request cannot be retained.

Before sending a batch, the browser stores its immutable request ID, destination and quantities. A network error with no definite outcome freezes that draft. **Confirm previous save** checks the server receipt first; if absent, the same payload and ID can be retried after password confirmation. A confirmed response clears the draft and retains the receipt. Reloading a Stock quick-add link does not increment the draft again.

## Database behavior

Migration `20260927220000_inventory_receiving_batches.sql` adds an RPC-only receipt table, `receive_inventory_batch` and `get_inventory_receiving_receipt`. Both require existing inventory permissions, and receipts are scoped to the authenticated user. New tables have RLS and no client table privileges. Employee identity/email come from the authenticated server identity. Password confirmation remains a browser reauthentication step as in the prior Add Inventory flow; the RPC independently enforces inventory authorization.

One transaction validates active items, destination and parent/store, positive whole quantities, duplicates, and destination capacity. It increments only good-condition loose stock (`batch_id is null`), creates a stock transaction for every line, updates inventory metadata, and stores the receipt. Existing defective stock and bag quantities are untouched. Locks serialize a destination's batches and request IDs; SQL increments avoid the prior browser read/modify/write race. A bad line rolls back all stock changes and audit records. Request IDs cannot be reused with a different payload.

Limits: 100 distinct item lines per batch; quantities 1-999999; batch note up to 1000 characters. A batch has one destination. For another destination, start the next batch. Receipts represent counts at the time of saving, not a live stock count.

## Scan counting and weighed bags

**Scan counting / bulk bags** opens `add-inventory.html?mode=count`. The previous scan-counting workflow remains available; its ordinary stock save now uses the same atomic RPC. The button previously called Submit Current Batch is accurately named Place Next Item because that workflow handles one item at a time. Weighed bag creation remains its existing workflow rather than being treated as loose inventory.

Weighed-bag saving is repaired by `20260928010000_repair_bulk_bag_receiving.sql`. The captured barcode is reused on the label, registry, stock and audit. Each capture owns its measurements and attachments. `receive_bulk_bag` checks the weights, computes the quantity, validates the destination, and commits registry/stock/audit/receipt together. Retrying the same bag returns its receipt; reusing its barcode for a different bag is rejected. A bag captured without a destination is registered but does not claim placed stock. When a new catalog item has saved but its bag has not been confirmed, the success panel offers **Retry bag save** against that same item and captured barcode; retrying never inserts another catalog item.

The repaired stock trigger uses the real stock rows rather than nonexistent bag columns. It retires a bag only when all its placements are empty and clears retirement when quantity returns. Inserts, quantity edits, deletion and batch reassignment are covered. Existing historical bag records are not rewritten or refilled automatically. Label/photo storage remains optional and separate from the inventory transaction; storage upload failures do not create a partial stock save.

## Validation

- `npm run test:add-inventory`: browser coverage for multi-item saving, repeated scans, quantity validation, account confirmation, receipts, optional labels, mobile layout, safe rendering, removal/Undo and reload/lost-response recovery.
- `INVSTO_ITEM_BROWSER=webkit` uses the phone browser engine.
- `supabase/tests/inventory_receiving_test.sql`: 27 transactional pgTAP checks for permissions, validation, stock/audit atomicity, retries, isolation of bag/defective stock and catalog preservation. Tests roll back fixtures.
- Barcode scanner regressions still cover camera acceptance and the legacy scan flow. No real stock is saved or physical label printed by browser tests.

- `supabase/tests/bulk_receiving_test.sql`: 30 rollback-only checks for weighed bags, retry isolation, validation, audit failure rollback and bag retirement.
- `npm run test:print-stations`: includes exact captured bag barcode/label, per-capture measurements, retries, rejection and empty/negative weight checks.
