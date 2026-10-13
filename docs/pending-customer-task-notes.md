# Customer tasks in Pending Orders notes

The buyer card combines ordinary line notes with open tasks for the same eBay
customer. Independent/customer-service tasks, linked message tasks, return tasks,
and tasks from other orders can appear here. This is a read-only projection; it
does not attach those tasks to the current order or change packing ownership.

Matching uses exact, case-insensitive eBay usernames from structured metadata,
the associated order/return, or the linked conversation. Legacy conversations
may use one unambiguous confirmed buyer-username link. Names, titles, partial
usernames, suggested links and conflicting conversation identities are not used.
Existing table RLS controls which tasks and evidence each employee can see.

Resolved, canceled, accepted/finished, removed and hidden audit tasks are excluded.
Work completed by an employee but still awaiting acceptance remains open. A task
already shown for the current order is not repeated as a customer task. An open
task for another line appears as customer context, without becoming a packing
assignment for the currently displayed line.

The compact entry shows the task message, assignee and creation date. Its Details
row shows status and file count; expanding it reveals updates, context and the
link to the task. Existing order-task photos remain directly accessible there.
For customer tasks, Open task leads to the existing task/evidence view.

Lookups are lazy, batched for visible cards, cached per queue load, and paginated
in 500-row pages. Refresh reloads customer tasks; task edits made in Pending
Orders invalidate the cache. Failures retain the notes and offer Retry.

Database: `20261009010000_pending_customer_task_notes.sql` is an additive,
security-invoker read function plus indexes. It changes no business data or RLS.

Validation: `tests/pending-customer-task-notes-database.test.mjs`,
`tests/pending-order-notes.test.mjs`, and `tests/pending-mobile.test.mjs`.

## Customer promises and signed fulfillment

Use **Customer task** in Messages, a Pending Orders buyer card, or the Tasks
header. The shared phone-friendly form takes the exact eBay username, title,
specific instructions, responsible person, and priority. Messages and orders
prefill the username. An order does not have to exist yet. Saves are idempotent
and a failed save retains the draft. These tasks are explicitly shared with
inventory staff, without broadening access to unrelated tasks.

The form also accepts up to ten photos (20 MB each), with previews and removal
before saving. Upload and task-save retries reuse the same private evidence
objects. Existing tasks accept photos through **Add update → Attachments**.
Customer tasks created in Messages retain the original conversation and message,
including a server-sourced preview and an **Open eBay Conversation** link. They
also appear in that conversation's task list. For older promises, the creator or
an admin can use **Link original conversation**; the server checks the exact
customer and message, preserves ownership and fulfillment state, and audits the
link. Migration: `20261013150000_buyer_task_message_photos.sql`.

Customer promises appear first and expand in the buyer's notes. Their original
instructions remain prominent even after later updates. **Review & sign customer
promises** shows each promise and order separately. Staff must enter fulfillment
details, type their signature, and check an explicit certification. Identity and
time are recorded by the server along with a snapshot of the instructions.
An admin can instead sign a reason to allow **that order only** to proceed;
the task remains open for the next order. Admin access is checked in the database,
independently of the Pending Orders screen's broader staff controls.

Every local signed-in fulfillment path is protected by database triggers on
order lines and orders, including live bags, bundles, partial quantities and
admin closeout. The browser rechecks before checkout and fails closed on lookup
errors. All open promises require an order-specific decision. Changed
instructions invalidate previous signatures. A promise cannot be certified for
two orders simultaneously; an admin must change the first decision to deferral.

Certification closes the task only when the entire certified order finishes,
in the same transaction as fulfillment. Failed or partial checkout leaves it
open. Reversing fulfillment reopens it and requires a fresh signature. Deferrals
never close the task. The existing task event history preserves signatures,
admin decisions, completions and reversals. Ordinary task acceptance cannot
bypass certification. Historical service imports retain the existing treatment
of fulfillment facts; they do not represent a new staff checkout.

Migrations: `20261013130000_buyer_followup_tasks.sql` and
`20261013140000_buyer_promise_fulfillment.sql`. Current signoffs are read-only to
clients; only authenticated RPCs can write them. New regression coverage:
`tests/buyer-promises-database.test.mjs` and
`tests/buyer-promises-browser.test.mjs`, plus real Messages and Pending Orders
entry points in their workspace tests.
