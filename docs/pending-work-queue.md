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

**Watch → Set Pending CGL** records a requirement for that item. Save a certificate
copy through the existing certificate panel, then explicitly confirm it belongs
to the watch. Confirmation is available in Pending Orders, Packaging and History.
A wrong/voided certificate reopens its requirement. Removing a requirement needs
a correction reason; removing Watch cannot silently erase an existing requirement.

Blockers are audited in `pending_order_work_events` and scoped to saved line IDs
in `pending_order_work_blocker_lines`, with normalized buyer grouping. They do not
follow later purchases after their original lines leave the pending queue.
Database triggers reject local full/partial completion anywhere in the buyer
bundle while blockers remain, including older clients. Packaging also checks
its own order IDs for invalidated CGL requirements before ready/dispatch. Service
imports can preserve fulfillment facts reported by eBay. No inventory, payment,
task, or existing order data is backfilled or reclassified by this migration.

Private order broadcasts refresh statuses across staff clients; reconnect,
foreground, online and a 60-second fallback refresh cover missed broadcasts.
Failed reads show an explicit retry state and never imply an unknown buyer is
ready. Mutations are server-validated, audited, and use idempotent create IDs or
revision checks. Read requests are batched and paginated.

Deploy `20261011010000_pending_work_blockers.sql` before publishing the page and
shared certificate assets. Focused tests: `pending-work-database.test.mjs`,
`pending-work-client.test.mjs`, `pending-watch-flags.test.mjs`, and the existing
customer task-note tests. Responsive interaction QA uses the actual pending
page renderer with isolated fixture data, plus a read-only check of the live UI.
