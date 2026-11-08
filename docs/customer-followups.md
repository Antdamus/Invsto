# Customer follow-ups

`customer-followups.html` is the shared staff workspace for calls, call follow-ups, and manual returns arranged outside the marketplace return process. Both navigation menus link to it. eBay and TikTok conversations offer call and return actions; each eBay history line also offers a manual return action and a link to its follow-ups.

Standalone entries do not require a chat. Returns require an existing eBay or TikTok order line. Search accepts order numbers, buyer names/usernames, and item titles/numbers; a chat scopes the search to its exact buyer. Saved records retain the order/customer snapshot and any original conversation. Contact information absent from imported orders can be entered manually. Return quantities cannot exceed the purchased quantity.

All active inventory staff can read the shared records and append audited updates. Writes run through authenticated RPCs with optimistic revisions and idempotent request IDs. Notes and photos remain in the event trail. Photos use the private `customer-followup-photos` bucket, limited to 20 MB each and ten per update. The new workflow does not modify marketplace returns, inventory, refunds, or order fulfillment.

A record can have multiple ordinary team tasks created through `create_task_request`. Assignment, notifications, completion, and review keep using the existing Tasks workflow. Tasks link back to the customer record. A record cannot be closed or cancelled while linked tasks remain unfinished; reopening allows further tasks.

The calls and manual-return report buttons produce separate reports using the current search/status/due filters. Print/save PDF includes the client and order details, activity, photos, and task summaries. CSV includes notes and record links and escapes spreadsheet formulas. Reports identify their filters and generation time. Saved contact details may be incomplete or masked by the marketplace; absent information is labelled as missing rather than inferred.

Each card and record has **Update** and **Done** actions. Update appends a dated team conversation entry without changing the record's status. Done requires an outcome and moves the record to **History**, preserving every note, photo, task and customer/order detail. History supports additional updates and an audited **Reopen** action. Unfinished linked tasks must be completed first; a failed Done keeps the outcome draft and shows links to those tasks. Reports respect the selected Active/History view and include the final outcome.

Verification:

```text
node --test tests/customer-followups-database.test.mjs
node --test tests/customer-followups-browser.test.mjs
```

The browser suite uses local fixtures only; it never creates production records or messages customers. Database tests verify access, exact buyer/item matching, photo ownership, revisions, idempotency, task links, and closure rules. The production smoke check uses a rolled-back transaction.
