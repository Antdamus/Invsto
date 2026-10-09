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
