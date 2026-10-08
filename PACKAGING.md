# Packaging operations

Open `packaging.html` from the staff navigation. Scan a shipping tracking barcode
with a keyboard scanner or the existing camera scanner. Review the linked orders,
confirm the quantities physically in this box, and save at least one packing photo.
Photos and short videos use the existing private task-evidence storage (50 MB per
file, up to 30 files). Original order/bag photos remain reference evidence.

**Packaged · Sending today** records the packer, time and planned dispatch date in
America/New_York. **Confirm dispatched** is a separate physical carrier handoff.
Nothing in Packaging consumes inventory or changes eBay fulfillment status.

Issue tasks reuse Work/Decision assignments, replies, acceptance and notifications.
Blocking tasks hold the package until accepted/resolved; merely completing one's
part or cancelling a task does not release the hold. Resume requires a note and
a fresh physical review. A cancelled blocking task should be reopened and properly
resolved in Tasks if it was created in error.

Combined saved labels resolve all associated order IDs. An ambiguous barcode asks
the packer to choose its order group. An unknown external label can be associated
only after opening an eligible order, checking its recipient/order numbers, and
recording a reason. A second tracking code can hold the remaining quantity in a
separate box. No item quantity can be allocated twice. Reference evidence is not
counted as new packing proof.

Claims last 15 minutes and renew on writes. Other employees may inspect the package
but cannot edit it while claimed. Refresh and claim again after expiry. Optimistic
revisions reject stale writes; request IDs make retries safe after lost responses.
An admin can reopen/cancel with a reason. Evidence and events are retained. These
corrections never reverse or repeat stock deductions.

## Deployment and cutoff

1. Apply `20261008020000_packaging_workspace.sql`. It installs **disabled**.
2. Deploy the page and matching Pending Orders / Tasks / navigation changes.
3. Verify the live page and RPC; then apply `20261008021000_activate_packaging.sql`.
4. Confirm `packaging_settings.enabled` and `activated_at`, and the empty/new queue.

Only staff-authenticated local completion changes after activation register a
handoff. The order becomes available after all its lines are terminal and it has
fulfilled items. Importing an external shipped status, printing a label, or touching
an old order does not populate this queue. Existing historical orders are not
backfilled. Orders partially completed before activation enter when staff complete
their remaining work after activation.

The old client shipping-task shortcut is guarded in the database. Shipping tasks
for handed-off orders close only when every fulfilled quantity is dispatched.
Order photos, notes, tasks and related boxes remain accessible from each package.
The order notes section shows the latest 200 order events. Photo references are
loaded independently of that notes window so older screenshots remain available.

Item screenshots appear beside their saved order lines. Photos with no reliable
item association appear under Other order references instead of being guessed onto
an item. Completion photos have their own visible section and a shortcut at the
package header. They remain reference evidence and never satisfy the requirement
for a new packaging photo. Tap a photo to see it without cropping, zoom, browse the
other photos in its group, or open the original. Arrow keys and Escape also work.
Preview images load near the viewport, with a limit of four simultaneous reads;
originals load when opened. Corrected/removed photos are excluded from legacy
closeout snapshots. The reference query uses the existing inventory staff access.

Apply `20261008220000_packaging_reference_photos.sql` before publishing the photo
interface. This replaces only the read-only detail query; it does not create
handoffs, change claims, adjust stock, or dispatch packages.

To pause **new handoffs** without deleting work, set `packaging_settings.enabled`
to false. Retain the page and database functions so the department can finish its
existing packages. Never undo this migration by dropping tables containing work.

## Verification

`npm run test:packaging` tests database transitions and isolated browser fixtures.
Use `INVSTO_ITEM_BROWSER=webkit` for the iPhone browser engine. The database tests
cover activation, partial and combined orders, duplicate scans, split quantities,
claims, stale/retried requests, real scoped media, task holds, carryover, dispatch,
admin corrections, legacy tasks and authorization. Browser tests use 320, 390,
768, 1366 and 1920 px and block all external application requests. Do not create,
close, pack or dispatch real business orders as test fixtures.
