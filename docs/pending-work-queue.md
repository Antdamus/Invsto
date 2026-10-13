# Pending Orders work queue

Every shipping-date view supports **Ready to work**, **Waiting**, and **All**.
Ready means there is no explicit processing hold, not that stock, payment,
labels, photos, or every other shipping prerequisite has been verified. Existing
fulfillment safeguards still apply. Buyer bundles are never split by this filter.
Searches, scans and incoming order links include both queues so held orders can
always be found. Desktop date summaries show ready/waiting buyer counts; the
phone uses the same secondary controls below its date tabs. CGL counts item lines.

**Set as waiting** on a collapsed buyer card records a reason or links an existing
open customer task. It never creates a generic task or changes task ownership.
A linked task stops blocking after final resolution/acceptance/cancellation;
`completed_by_employee` still waits for review. Reopening the task restores the
hold while its scoped items are still pending. Manual holds require an explicit
release reason. Releasing one blocker never releases another one. Ordinary
customer tasks remain compact notes without automatically holding a package.

New waiting holds show a persistent **Undo** notice until dismissed or replaced
by the next change. Undo releases only the hold just created, using its original
revision; a changed CGL requirement cannot be accidentally undone. Later, open
**Manage waiting → Remove from waiting** for a manual/task hold; a reason is
optional and the release is audited. Linked tasks stay open, and other blockers
still apply. CGL/missing-watch corrections keep their dedicated correction flows.

**Watch → Set Pending CGL** records a requirement for that item. Save a certificate
copy through the existing certificate panel, then explicitly confirm it belongs
to the watch. Confirmation is available in Pending Orders, Packaging and History.
A wrong/voided certificate reopens its requirement. Removing a requirement needs
a correction reason; removing Watch cannot silently erase an existing requirement.

**Watch → Watch missing** creates a separate hold for that item. The missing-watch
filter and summary count watch item lines and keep the entire buyer package together.
**Mark watch found** requires staff to confirm they located and checked the watch;
its release is audited. A correction reason can clear a mistaken marker. Finding
the watch does not clear CGL or other blockers. Apply migration
`20261011012000_pending_missing_watches.sql` before publishing this control.

**Item not found** filters the existing explicit not-found markers across Ready
and Waiting. The count is pending item lines; buyer packages stay together. Items
with no marker are not treated as missing. Marking an item found removes it from
the count and removes its buyer from this view once no other items are missing.
The existing item-search update stream keeps this filter current. This filter
does not create tasks, holds, or new item statuses.

Blockers are audited in `pending_order_work_events` and scoped to saved line IDs
in `pending_order_work_blocker_lines`, with normalized buyer grouping. They do not
follow later purchases after their original lines leave the pending queue.
Missing-watch holds reject completion only for the marked lines. Staff can leave
those lines unchecked and complete the available lines together, including lines
from the same order. The missing watches and their holds remain pending; the buyer
stays in Waiting until its requirements are cleared. Selecting a missing watch
still rejects the save. Manual, task, CGL and pending-cancellation holds retain
their existing buyer-wide completion checks, including for older clients.

Completed lines enter Packaging even when other lines of the order are pending.
Only completed lines can be added to the box; the package shows a partial-shipment
notice. Missing-watch dispatch checks use the confirmed box contents. Shipping
tasks stay open until every remaining item is completed and dispatched. Packaging
also checks its order IDs for invalidated CGL requirements before ready/dispatch. Service
imports can preserve fulfillment facts reported by eBay. No inventory, payment,
task, or existing order data is backfilled or reclassified by this migration.

Private order broadcasts refresh statuses across staff clients; reconnect,
foreground, online and a 60-second fallback refresh cover missed broadcasts.
Failed reads show an explicit retry state and never imply an unknown buyer is
ready. Mutations are server-validated, audited, and use idempotent create IDs or
revision checks. Read requests are batched and paginated.

Deploy `20261011010000_pending_work_blockers.sql` and
`20261011011000_pending_work_responsibility.sql` before publishing the page and
shared certificate assets. Focused tests: `pending-work-database.test.mjs`,
`pending-work-client.test.mjs`, `pending-watch-flags.test.mjs`, and the existing
customer task-note tests. Responsive interaction QA uses the actual pending
page renderer with isolated fixture data, plus a read-only check of the live UI.

Partial shipments require `20261013201000_partial_pending_watch_fulfillment.sql`
and `20261013202000_partial_order_packaging.sql` before publishing the pending
and packaging pages. No existing order, hold or package is completed by deployment.
