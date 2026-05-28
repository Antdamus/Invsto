# Step 5F.6B eBay-First Reconsideration Audit

Audit date: 2026-05-28

Scope: architecture audit only. No code changes, migrations, deploys, Supabase repair, database push, Outlook mutations, eBay mutations, sends, or secret reads were performed.

## Executive Summary

This audit reconsiders Step 5F.6A under a stronger product assumption:

```text
The product is now an eBay-first messaging platform.
Outlook is no longer the canonical conversation model.
```

Under that assumption, the recommendation becomes clearer than 5F.6A:

```text
Yes. Build eBay-first canonical messaging.
Use Supabase as the AI operational intelligence layer.
Keep Outlook only as temporary fallback, audit evidence, relay backup, and non-eBay email support.
```

The long-term operator experience should be powered by eBay-native conversation and return-message data, not Outlook notification emails. The current Outlook pipeline still contains valuable AI, context, classification, draft, pagination, operational-event, and matching work, but its mailbox model should be demoted for eBay communications.

The repo already contains meaningful eBay infrastructure created by another developer/team member:

- Sell Fulfillment API order sync through `ebay-order-sync`.
- Sell Fulfillment API buyer/account archive sync through `ebay-buyer-history-sync`.
- Post-Order Return API sync through `ebay-return-sync`.
- Return message import/logging into `ebay_return_messages`.
- Inventory/listing sync through `ebay-inventory-sync`.
- Account policy setup through `ebay-publishing-setup`.
- eBay OAuth code exchange helper through `ebay-oauth-callback`.
- Browser/page-transfer bridges for labels, reports, returns, return message logs, video receipt photos, and cancellation proof.
- Many RPCs and event tables for order, return, task, label, and audit workflows.

However, the existing eBay infrastructure is not yet sufficient for Commerce Message API messaging without verification and likely OAuth changes. Current default scopes in repo code do not include:

```text
https://api.ebay.com/oauth/api_scope/commerce.message
```

The existing refresh token may or may not already include that scope if someone overrode `EBAY_OAUTH_SCOPES` when generating it, but the repo does not prove that. Because eBay scopes are consent-bound, requesting `commerce.message` during refresh will only work if the seller previously granted it. If not, OG will need a fresh eBay OAuth consent/reconnect with the Commerce Message scope and possibly confirmation that the active Production keyset exposes that scope on the eBay Developer Portal Application Keys page.

Lowest-risk next step:

```text
Step 5F.6C - Read-only Commerce Message API Capability Probe
```

That probe should test OAuth scope availability and read-only conversation retrieval before any schema migration or send implementation.

## 5F.6A Reconsidered Under eBay-First Assumption

Step 5F.6A recommended a hybrid architecture:

```text
eBay = canonical where accessible
Outlook = notifications, relay fallback, non-eBay coverage
Supabase = normalized operational intelligence layer
```

That was correct when the decision still allowed Outlook to remain a primary path. Under the new eBay-first assumption, the hybrid recommendation should be narrowed:

```text
eBay is canonical for all eBay communications.
Supabase is the system of record for normalized operational state, AI state, drafts, send attempts, links, and audit.
Outlook is not a coequal source of truth for eBay conversations.
```

The new framing is:

- Outlook may remain in the system, but not as the eBay conversation authority.
- Outlook imports should become evidence and fallback transport, not the main inbox model.
- Email Triage should be renamed or reframed for eBay messaging work; the existing Email Triage work can be reused under a new provider-neutral or eBay-first layer.
- The roadmap should stop polishing the Outlook mailbox UI as the primary operator surface.
- Future migrations should create eBay conversation tables instead of trying to derive eBay chat from email blobs.

## Final Architecture Answer

The project should become:

```text
eBay-first canonical messaging
+ Supabase AI operational layer
+ optional Outlook fallback only
```

This means:

- Normal buyer/member messages should come from eBay Commerce Message API if the seller account and keyset support it.
- Return messages should continue using Post-Order Return API data and should add Post-Order send later.
- Conversation, classification, draft, and send state should live in Supabase eBay messaging tables.
- Outlook eBay notifications should be linked to eBay conversations only as supporting evidence.
- Outlook relay sending should remain a backup until eBay API send is proven, then degrade to emergency fallback.

## Outlook Reassessment

If eBay Message APIs work properly, Outlook no longer has a durable operational reason to be the canonical eBay messaging layer.

### What Outlook Should Become

Recommended role:

| Outlook role | Keep? | Reason |
| --- | --- | --- |
| Canonical eBay conversation source | No | Outlook notifications are wrappers, not the native eBay conversation resource. |
| Primary eBay inbox UI | No | The desired UI is one row per eBay conversation, not one row per email. |
| Relay fallback | Temporarily yes | Manual test proved Outlook relay replies can post into eBay chat. |
| Audit evidence | Yes | Notifications can prove a message event happened and can help debug eBay/API gaps. |
| Migration safety net | Yes | Useful while Commerce Message API access is being validated. |
| Non-eBay email triage | Yes, if still desired | The Outlook pipeline is still valuable for non-eBay customer/vendor messages. |
| Long-term eBay send path | Only fallback | eBay API send should be primary if available. |

### What Disappears Later

Outlook can eventually disappear from the eBay communication workflow if all of these are true:

- Commerce Message API can fetch real OG buyer/member conversations in Production.
- Commerce Message API returns clean timelines, sender/recipient usernames, timestamps, unread/read state, media, and listing references for the message types OG needs.
- Commerce Message API send works for normal buyer/member replies.
- Post-Order send works for return-case replies.
- eBay sync cadence is reliable enough that Outlook notifications are not needed for freshness.
- Operators have deep links back to eBay for exception handling.

Outlook should not disappear from the repo as a whole unless OG also decides to stop handling non-eBay email.

### What Must Stop

Do not keep investing in:

- Outlook body parsing as the path to clean eBay chat.
- Outlook `conversation_id` as eBay conversation identity.
- One email row per eBay notification as the primary eBay operator inbox.
- Email-only classification and draft state as the final abstraction.
- Outlook send as the assumed primary safe-sending implementation.

## Existing eBay Infrastructure Audit

### Overall Finding

The repo already has a serious eBay operational substrate. It is not just a manual CSV app. Existing code can be reused for authentication patterns, eBay API request helpers, order/return context, return message import, sync runs, page-transfer logging, and operator workflows.

The missing piece is a first-class normal eBay conversation subsystem:

```text
No current function calls /commerce/message/v1.
No current table stores normal eBay conversation headers.
No current table stores normal eBay member message timelines.
No current send-attempt table exists for eBay messages.
No current OAuth default scope includes commerce.message.
```

### Frontend and Module Findings

| File | Current purpose | Reuse for eBay-first messaging |
| --- | --- | --- |
| `pending-orders.html` | Pending eBay order workflow, API sync controls, label/report/extension panels. | Reuse order context and sync control patterns. Not the messaging UI. |
| `pending-orders.js` | Pending order queue, eBay order API sync, label transfer, report transfer, video/cancel proof transfer, order task RPC usage. | Reuse API sync UI patterns, transfer/event approach, buyer grouping ideas. Messaging should be separate. |
| `ebay-order-history.html` | Order history and returns surface. | Useful as context/back-office reference. |
| `ebay-order-history.js` | Historical order lookup, return queue, return message log rendering, return API sync, buyer archive sync, label/return/page-transfer handlers. | Very reusable for return message rendering, return sync, buyer history, and page-transfer audit patterns. |
| `ebay-buyer-insights.js` | Buyer modal using buyer-insight RPCs and sync-state rows. | Reuse buyer summary cards inside conversation detail. |
| `ebay-returns.html` | Return workflow shell using shared order-history logic. | Reuse return message log behavior and return task context. |

### Edge Function Findings

| Function | Current APIs | Current write targets | Reuse assessment |
| --- | --- | --- | --- |
| `ebay-order-sync` | eBay Sell Fulfillment API order list/detail. | `ebay_order_sync_runs`, `ebay_orders`, `ebay_order_lines`, `ebay_order_line_reservations`. | Strongly reusable for order context and order staleness. Not a message source. |
| `ebay-return-sync` | eBay Post-Order Return API search/detail/files. | `ebay_return_sync_runs`, `ebay_return_cases`, `ebay_return_items`, `ebay_return_tasks`, `ebay_return_task_events`, `ebay_return_messages`, return evidence storage. | Strongly reusable. This is the closest existing pattern to future messaging sync. |
| `ebay-buyer-history-sync` | eBay Sell Fulfillment API archive scans. | `ebay_orders`, `ebay_order_lines`, `ebay_buyer_history_syncs`, `ebay_account_history_sync_runs`. | Strongly reusable for buyer context and old order correlation. |
| `ebay-inventory-sync` | eBay Sell Inventory API inventory item/offer/publish. | `ebay_inventory_links`, `ebay_inventory_sync_runs`, public eBay photo storage. | Reusable for listing/reference correlation. Not a messaging subsystem. |
| `ebay-publishing-setup` | eBay Account API policies and Inventory locations. | `ebay_inventory_settings`. | Reusable OAuth/request pattern. Not directly messaging. |
| `ebay-oauth-callback` | eBay OAuth authorization-code exchange. | No DB writes; displays token payload for manual secret copy. | Reusable as a rough reconnect helper, but must be redesigned for messaging-grade token storage. |
| `ebay-feedback-sync` | Legacy Trading API `GetFeedback` and `GetItem`. | `customer_testimonials`/review-related tables. | Low reuse. Shows legacy token pattern only. |
| `sync-ebay-feedback` | Placeholder sample function. | None meaningful. | Ignore. |
| `ebay-account-deletion` | eBay account deletion notification verification/webhook. | `ebay_account_deletion_notifications`. | Compliance-only; useful webhook example. |

### Important Config Finding

`supabase/config.toml` lists several eBay functions with `verify_jwt = false`, including:

- `ebay-inventory-sync`
- `ebay-account-deletion`
- `ebay-oauth-callback`
- `ebay-publishing-setup`
- `ebay-return-sync`

But the inspected config did not list:

- `ebay-order-sync`
- `ebay-buyer-history-sync`

The frontend directly builds hosted function URLs for both. This may mean they were deployed manually or config drift exists. It should be verified before building the new messaging function.

For future message functions, do not copy the current public unauthenticated sync pattern blindly. A message probe function can be admin-only and still use service-role internally.

### Existing eBay API Request Pattern

The current modern eBay functions share this pattern:

- Read `EBAY_CLIENT_ID` or fallback `EBAY_APP_ID`.
- Read `EBAY_CLIENT_SECRET` or fallback `EBAY_CERT_ID`.
- Read one global `EBAY_REFRESH_TOKEN`.
- Read `EBAY_ENV`, defaulting to `production`.
- Read function-specific scope env var.
- Use refresh-token grant against `/identity/v1/oauth2/token`.
- Call the eBay REST endpoint with the minted access token.

This is reusable for a read-only Commerce Message API probe, but it is not ideal long-term because:

- There is one global seller token, not a DB-backed account/token model.
- The refresh token is a Supabase secret, not rotated through a persistent token table.
- Granted scopes are not stored in a table for runtime inspection.
- Token ownership/account identity is not represented locally.
- OAuth reconnect is manual and currently displays tokens to a browser page for copy/paste.
- Existing functions duplicate token-refresh helpers instead of sharing one eBay auth module.

## Existing RPC Audit

The repo has many eBay-related RPCs. The future messaging architecture does not need all of them, but several are important because they already model task events, return logs, order context, and buyer insights.

### Return and Return Message RPCs

| RPC | Current purpose | Reuse/evolution |
| --- | --- | --- |
| `record_ebay_return_message_log` | Records a message typed/sent on the eBay return page. Inserts `ebay_return_messages` and appends a task event. Does not send. | Very reusable pattern. Evolve into generic send/open/log audit only after native send tables exist. |
| `open_ebay_return_case` | Creates/adopts a matched eBay return case and return task. | Reuse for return context. Do not use for normal messages. |
| `open_unmatched_ebay_return_case` | Creates review case/task when no OG order match exists. | Reuse for unmatched return triage. |
| `close_ebay_return_case_from_page` | Closes/updates return case from eBay page transfer data. | Reuse as page-transfer evidence pattern. |
| `receive_ebay_return` | Processes physical return intake, evidence, disposition, restock. | Keep as returns workflow. Not messaging. |
| `assign_ebay_return_task` | Assigns a return task. | Keep as task workflow. |
| `create_ebay_return_question_task` | Creates a return follow-up/question task. | May complement conversation escalation. |
| `update_ebay_return_task_status` | Updates return task status and appends events. | Reuse event model. |
| `sync_ebay_return_tasks_after_intake` | Syncs return task state after intake. | Keep returns workflow. |
| `update_ebay_return_task_export_metadata` | Stores return export/page metadata. | Reuse metadata approach cautiously. |
| `list_my_ebay_return_tasks` | Worker return task dashboard data. | UI-side context only. |
| `admin_clear_ebay_return_import_test_data` | Maintenance cleanup for return import test data. | Not part of messaging architecture. |
| `reconcile_ebay_return_task_duplicates` | Maintenance reconciliation. | Useful operational pattern, not core messaging. |

### Order, Label, and Task RPCs

| RPC | Current purpose | Reuse/evolution |
| --- | --- | --- |
| `fulfill_ebay_order_line`, `fulfill_ebay_order_line_for_store`, `fulfill_ebay_order_line_with_live_lot`, `fulfill_ebay_order_line_with_live_lot_for_store` | Fulfillment actions linking eBay lines to OG inventory/sales. | Order context only. |
| `admin_close_ebay_order_lines` | Admin closeout/cancellation-like order actions. | Context/audit only. |
| `cancel_ebay_order_lines` | Local cancellation workflow with proof. | Context/audit only. |
| `complete_ebay_order_lines_without_inventory*` | Worker/admin no-inventory completion flows. | Context/audit only. |
| `attach_ebay_shipping_label`, `attach_ebay_extra_shipping_label` | Label attachment and event audit. | Useful for shipping-related message context. |
| `backfill_ebay_label_tracking_metadata` | Label/tracking metadata maintenance. | Useful context/staleness signal. |
| `create_ebay_order_coordination_task` | Creates internal order task. | Conversation escalation can reuse task linking patterns. |
| `respond_ebay_order_coordination_task` | Updates internal order task and appends events. | Reuse task event style. |
| `assign_ebay_order_shipping_task`, `handoff_ebay_order_shipping_task` | Shipping workflow assignment/handoff. | Context only. |
| `list_ebay_order_task_assignees`, `list_my_ebay_order_tasks`, `list_admin_ebay_order_tasks` | Task dashboard data. | Useful for context cards and escalation. |
| `create_ebay_order_subtask`, `approve_ebay_order_subtask`, `send_back_ebay_order_subtask` | Employee workflow around order tasks. | Context/escalation only. |

### Buyer and Sync RPCs

| RPC | Current purpose | Reuse/evolution |
| --- | --- | --- |
| `get_ebay_buyer_insights` | Buyer summary, recent orders, returns, value/profit context. | Strongly reusable in conversation detail. |
| `get_ebay_buyer_return_value_breakdown` | Return value breakdown by buyer. | Reuse for operator-only prioritization. |
| `get_ebay_buyer_value_line_breakdown` | Buyer value line breakdown. | Reuse for context cards; do not expose to buyer. |
| `list_ebay_buyer_profitability` | Buyer profitability list. | Operator-only; not buyer-facing. |
| `get_ebay_sync_candidate_item_ids` | Inventory sync candidate selection. | Useful for inventory sync only. |
| `mark_ebay_item_dirty`, `mark_ebay_item_dirty_from_item`, `mark_ebay_item_dirty_from_stock` | Marks inventory listing state dirty. | Not messaging, but listing state can inform context. |

### Operational Event and Notification RPCs

The existing eBay event architecture is mostly table-specific:

- `ebay_order_task_events`
- `ebay_return_task_events`
- `ebay_return_events`
- `ebay_order_admin_events`
- `ebay_order_label_events`
- `ebay_order_revert_events`

The existing Email Triage event architecture is generic but email-specific:

- `email_operational_events`

Future eBay messaging should not overload `email_operational_events` as the primary event stream. It should create or use a conversation-specific event/audit table such as:

```text
ebay_conversation_events
```

or a more generic:

```text
message_operational_events
```

The repo's task notification RPCs and triggers are useful patterns for status notifications, but they are not the canonical message audit.

## OAuth, Token, Secret, and Scope Audit

### Current eBay Secret Names Referenced In Code

Do not print values. The relevant secret/config names are:

| Name | Used by | Purpose |
| --- | --- | --- |
| `EBAY_CLIENT_ID` | Modern eBay REST functions and OAuth callback. | OAuth client ID/App ID. |
| `EBAY_APP_ID` | Fallback in modern functions; primary in legacy feedback. | Legacy/alternate App ID. |
| `EBAY_CLIENT_SECRET` | Modern eBay REST functions and OAuth callback. | OAuth client secret/Cert ID. |
| `EBAY_CERT_ID` | Fallback in modern functions; primary in legacy feedback. | Legacy/alternate Cert ID. |
| `EBAY_REFRESH_TOKEN` | Modern eBay REST functions. | Long-lived seller user refresh token. |
| `EBAY_ENV` | Modern functions and OAuth callback. | `production` or `sandbox`; defaults to production. |
| `EBAY_ORDER_SCOPE` | `ebay-order-sync`, `ebay-buyer-history-sync`; fallback for return sync. | Fulfillment/order scope request. |
| `EBAY_RETURN_SCOPE` | `ebay-return-sync`. | Return/Post-Order token request scope. |
| `EBAY_SCOPE` | `ebay-inventory-sync`. | Inventory token request scope. |
| `EBAY_ACCOUNT_SCOPE` | `ebay-publishing-setup`. | Account policy/inventory setup token request scope. |
| `EBAY_OAUTH_RUNAME` | `ebay-oauth-callback`. | eBay RuName/redirect URI value. |
| `EBAY_OAUTH_SCOPES` | `ebay-oauth-callback`. | Scopes requested during consent link generation. |
| `EBAY_SYNC_ALLOW_PUBLISH` | `ebay-inventory-sync`. | Extra server-side guard for publishing. |
| `EBAY_AUTH_TOKEN` | `ebay-feedback-sync`. | Legacy Trading API token. |
| `EBAY_DEV_ID` | `ebay-feedback-sync`. | Legacy Trading API developer ID. |
| `EBAY_SITE_ID` | `ebay-feedback-sync`. | Legacy Trading site ID. |
| `EBAY_COMPATIBILITY_LEVEL` | `ebay-feedback-sync`. | Legacy Trading compatibility version. |
| `EBAY_SELLER_USER_ID` | `ebay-feedback-sync`. | Legacy seller username for feedback. |
| `EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN` | `ebay-account-deletion`. | Notification endpoint verification. |
| `EBAY_ACCOUNT_DELETION_ENDPOINT_URL` | `ebay-account-deletion`. | Notification endpoint URL. |

### Current Default Scopes

Current defaults inspected in code:

| Function/config | Default scopes | Includes `commerce.message`? |
| --- | --- | --- |
| `ebay-order-sync` `EBAY_ORDER_SCOPE` | `sell.fulfillment.readonly` and `sell.inventory` | No |
| `ebay-buyer-history-sync` `EBAY_ORDER_SCOPE` | `sell.fulfillment.readonly` | No |
| `ebay-return-sync` `EBAY_RETURN_SCOPE` | base `api_scope`, `sell.fulfillment.readonly`, `sell.fulfillment` | No |
| `ebay-inventory-sync` `EBAY_SCOPE` | `sell.inventory` | No |
| `ebay-publishing-setup` `EBAY_ACCOUNT_SCOPE` | `sell.account.readonly`, `sell.inventory` | No |
| `ebay-oauth-callback` `EBAY_OAUTH_SCOPES` | `sell.inventory`, `sell.account.readonly` | No |

Therefore:

```text
The repo's default OAuth flow does not mint a Commerce Message-capable token.
```

The current production `EBAY_REFRESH_TOKEN` could only support Commerce Messaging if it was generated with an overridden scope list that included `commerce.message`. The repo does not prove that.

### Existing OAuth Flow Strengths

- A working eBay OAuth callback exists.
- The code already knows about RuName.
- Refresh-token grant already works for current APIs.
- Existing functions handle production/sandbox base URLs.
- The app already separates browser UI from service-role function calls for eBay API work.

### Existing OAuth Flow Weaknesses

- `ebay-oauth-callback` displays refresh and access tokens in HTML for manual copying. This is workable for setup, but not a durable production token-management system.
- eBay token material is stored as a Supabase secret, not encrypted per-account in a database table like Microsoft tokens.
- There is no `ebay_account_connections` table.
- There is no `ebay_account_connection_secrets` table.
- There is no recorded scope set, grant time, token owner username, token expiry, last refresh status, or reconnect-required state.
- All modern eBay functions duplicate refresh-token logic.
- The current pattern assumes one seller account/token.
- Several eBay sync Edge Functions are public unauthenticated in config.

### Is Current API Setup Sufficient For Commerce Message API?

Answer:

```text
Unknown from repo alone, and likely not sufficient without at least a scope update/reconnect.
```

What is known:

- Official eBay Message API requires `https://api.ebay.com/oauth/api_scope/commerce.message`.
- Current repo defaults do not request it.
- Existing functions do not call `/commerce/message/v1`.
- Existing migrations do not define Commerce Message tables.
- Existing OAuth callback default consent URL does not include it.

What must be verified:

- Whether the active Production keyset exposes `commerce.message` on the eBay Developer Portal Application Keys page.
- Whether the active `EBAY_REFRESH_TOKEN` was originally minted with `commerce.message`.
- Whether the authenticated seller account is the OG Jewelers seller account whose conversations should be managed.
- Whether eBay Message API returns the real conversation set for this seller in Production.

## Official eBay API Capability Findings

Official sources reviewed:

- eBay Message API overview: https://developer.ebay.com/api-docs/commerce/message/overview.html
- eBay Message API `getConversations`: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/getConversations
- eBay Message API `getConversation`: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/getConversation
- eBay Message API `sendMessage`: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/sendMessage
- eBay OAuth authorization guide: https://developer.ebay.com/develop/guides-v2/authorization#working-with-oauth-scopes
- eBay Post-Order send return message: https://developer.ebay.com/Devzone/post-order/post-order_v2_return-returnid_send_message__post.html
- eBay Post-Order get return: https://developer.ebay.com/Devzone/post-order/post-order_v2_return-returnid__get.html
- eBay API call limits: https://developer.ebay.com/develop/apis/api-call-limits
- eBay Sell Fulfillment get orders: https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders

Key verified details:

- Message API can send messages, retrieve conversations, retrieve messages within a conversation, and modify conversation status.
- `getConversations` requires `conversation_type`, with valid values including `FROM_MEMBERS` and `FROM_EBAY`.
- `getConversations` supports status, listing reference, username, and time-range filters; time-range filters currently apply to `FROM_MEMBERS`.
- `getConversations` returns conversation id, status, title, type, created date, latest message, reference id/type, unread count, paging, and total.
- `getConversation` returns message timelines with message body, message id, media, read status, sender username, recipient username, subject, and created date.
- `sendMessage` supports sending into an existing conversation by `conversationId` or starting a new one by `otherPartyUsername`.
- `sendMessage` requires either conversation id or other party username plus message text, and can include listing reference and media.
- `sendMessage` returns a message body with message id and message details on success.
- Commerce Message API requires `commerce.message`.
- eBay OAuth refresh tokens are sensitive, consent-bound, and adding a new scope requires a new permission grant from users.
- Post-Order return `send_message` can send a message about a return request, is not supported in Sandbox, and has no response payload beyond HTTP success.

## Information Needed From The Team

Do not expose values in chat or docs. The team should confirm the following in a secure channel or via a read-only capability probe.

### Keyset and Account

- Which eBay Developer Portal keyset is active for Production?
- Which eBay seller account owns the current `EBAY_REFRESH_TOKEN`?
- Is that seller account the OG Jewelers account that receives the tested buyer messages?
- Is `EBAY_ENV` set to `production` in hosted Supabase?
- Are `ebay-order-sync` and `ebay-buyer-history-sync` deployed even though they are not listed in `supabase/config.toml`?

### OAuth and Scopes

- Does the Application Keys page list `https://api.ebay.com/oauth/api_scope/commerce.message` as available?
- What exact scopes were granted when the current `EBAY_REFRESH_TOKEN` was minted?
- Does the current token refresh successfully when requesting only `commerce.message`?
- Does it refresh successfully when requesting existing scopes plus `commerce.message`?
- If not, can the seller reconnect with an updated consent URL?
- Should messaging use the existing `EBAY_REFRESH_TOKEN` or a new dedicated messaging token?

### Secret Names and Runtime

- Are these Supabase secrets set in Production: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `EBAY_ENV`, `EBAY_OAUTH_RUNAME`?
- Are fallback legacy names still used: `EBAY_APP_ID`, `EBAY_CERT_ID`, `EBAY_AUTH_TOKEN`, `EBAY_DEV_ID`?
- Are `EBAY_ORDER_SCOPE`, `EBAY_RETURN_SCOPE`, `EBAY_SCOPE`, `EBAY_ACCOUNT_SCOPE`, and `EBAY_OAUTH_SCOPES` explicitly set, or are functions using defaults?
- Should a new `EBAY_MESSAGE_SCOPE` be created rather than overloading existing scope env vars?
- Should a new `EBAY_MESSAGE_SYNC_DRY_RUN_ONLY` or send guard secret be added for early phases?

### API Behavior

- Can the token fetch `FROM_MEMBERS` conversations?
- Can it fetch `FROM_EBAY` conversations?
- Do returned conversations include recent real tested buyer messages?
- Do returned messages include seller replies that were sent through Outlook?
- Do returned conversations expose enough reference data to link listing IDs to orders/order lines?
- Are media URLs present and usable for attachments/photos?
- Does `unreadCount` match the native eBay inbox?
- Does marking conversations read/unread need to be part of beta?

### Product and Safety

- Should normal buyer messages and returns appear in one combined inbox or separate tabs with shared search?
- What is the desired maximum sync lookback for initial messaging import?
- Which operators may view messages?
- Which operators may draft?
- Which operators may approve/send?
- Should direct API send be disabled until manual verification is complete?

## Current Database Design Reassessment

### Email Tables

| Table | eBay-first disposition | Reason |
| --- | --- | --- |
| `email_mailboxes` | Demote/keep | Keep for Outlook fallback and non-eBay email. Not eBay canonical. |
| `email_messages` | Demote/keep | Useful notification evidence and fallback relay target. Not canonical eBay message row. |
| `email_message_bodies` | Demote/keep | Useful evidence only; stop parsing as native eBay chat. |
| `email_message_recipients` | Demote/keep | Useful relay/reply evidence and forensic context. |
| `email_message_links` | Generalize or complement | Current email-to-order links are useful, but future eBay messages need their own links. |
| `email_message_classifications` | Replace/complement | Keep for Outlook emails; create conversation/message-level classification tables for eBay. |
| `email_response_drafts` | Replace/complement | Keep pattern, but future drafts should target eBay conversations/messages, not only email messages. |
| `email_processing_jobs` | Replace/complement | Do not force eBay message sync into email jobs. Create eBay message sync/job records. |
| `email_sync_runs` | Keep for Outlook only | Do not overload for eBay API sync. |
| `email_sync_states` | Keep for Outlook only | eBay conversations need their own sync state. |
| `email_operational_events` | Demote/keep | Keep email ops; create eBay conversation operational events or generic message events. |

### Existing eBay Tables

| Table | eBay-first disposition | Reason |
| --- | --- | --- |
| `ebay_orders` | Keep | Core order context and buyer identity source. |
| `ebay_order_lines` | Keep | Core item/listing/transaction/order-line context. |
| `ebay_order_sync_runs` | Keep | Order sync staleness and audit. |
| `ebay_order_line_reservations` | Keep | Fulfillment context only. |
| `ebay_order_tasks` | Keep | Internal escalation/task context. |
| `ebay_order_task_events` | Keep | Internal task audit. |
| `ebay_order_label_events` | Keep | Shipping/tracking context. |
| `ebay_return_cases` | Keep | Canonical local return case header. |
| `ebay_return_items` | Keep | Return item/intake context. |
| `ebay_return_events` | Keep | Return audit. |
| `ebay_return_tasks` | Keep | Return workflow context. |
| `ebay_return_task_events` | Keep | Return task audit. |
| `ebay_return_messages` | Keep/evolve | Already stores return message timeline; may be complemented by generic conversation tables or linked as return conversation messages. |
| `ebay_return_sync_runs` | Keep | Return sync audit. |
| `ebay_buyer_history_syncs` | Keep | Buyer history freshness. |
| `ebay_account_history_sync_runs` | Keep | Account archive coverage. |
| `ebay_inventory_links` | Keep | Listing/SKU/offer bridge for message reference linking. |
| `ebay_inventory_sync_runs` | Keep | Listing context staleness. |
| `ebay_account_deletion_notifications` | Keep | Compliance only. |

## Proposed eBay-First Canonical Architecture

### Target Flow

```text
eBay Commerce Message API
  -> ebay_message_sync_runs
  -> ebay_conversations
  -> ebay_conversation_messages
  -> ebay_conversation_links
  -> ebay_conversation_classifications
  -> ebay_conversation_drafts
  -> ebay_message_send_attempts
  -> ebay_conversation_operational_events
  -> eBay-first operator inbox

eBay Post-Order Return API
  -> ebay_return_sync_runs
  -> ebay_return_cases / ebay_return_messages
  -> linked return conversation rows
  -> same operator inbox or Returns tab

Existing eBay order/history/inventory sync
  -> context enrichment and stale-context warnings

Outlook/Microsoft Graph
  -> notification evidence, relay fallback, non-eBay mailbox
```

### Recommended New Tables

Do not implement yet. Create migrations only after the read-only Commerce Message API probe proves access.

#### `ebay_conversations`

Purpose: canonical normal eBay member/platform conversation header.

Key columns:

- `id`
- `ebay_conversation_id`
- `conversation_type` (`FROM_MEMBERS`, `FROM_EBAY`)
- `conversation_status`
- `conversation_title`
- `other_party_username`
- `reference_type`
- `reference_id`
- `latest_message_id`
- `latest_message_at`
- `unread_count`
- `source_account_username`
- `marketplace_id`
- `last_synced_at`
- `sync_status`
- `raw_summary`
- `created_at`
- `updated_at`

Relationship:

- Complements `email_messages`.
- Becomes canonical for normal eBay buyer/member conversations.
- Links to orders/lines through `ebay_conversation_links`.

#### `ebay_conversation_messages`

Purpose: canonical normal eBay conversation timeline.

Key columns:

- `id`
- `conversation_id`
- `ebay_conversation_id`
- `ebay_message_id`
- `sender_username`
- `recipient_username`
- `direction` (`inbound`, `outbound`, `platform`, `unknown`)
- `subject`
- `message_body`
- `read_status`
- `sent_at`
- `received_at`
- `has_media`
- `dedupe_hash`
- `raw_message`
- `created_at`
- `updated_at`

Relationship:

- Replaces Outlook body parsing for eBay chat.
- Classification can run on new inbound messages and/or conversation rollups.

#### `ebay_conversation_attachments`

Purpose: store media metadata from Message API.

Key columns:

- `id`
- `conversation_message_id`
- `media_name`
- `media_type`
- `media_url`
- `storage_bucket`
- `storage_path`
- `download_status`
- `metadata`

Relationship:

- Similar to `email_attachments`, but for eBay message media.

#### `ebay_conversation_links`

Purpose: deterministic and reviewed links from conversations/messages to local eBay/order/return/inventory context.

Key columns:

- `id`
- `conversation_id`
- `conversation_message_id`
- `link_type` (`ebay_order`, `ebay_order_line`, `ebay_return_case`, `inventory_item`, `email_message`, `outlook_notification`)
- `ebay_order_id`
- `ebay_order_line_id`
- `ebay_return_case_id`
- `email_message_id`
- `item_id`
- `matched_value`
- `match_method`
- `confidence`
- `status`
- `metadata`

Relationship:

- Generalizes the useful idea behind `email_message_links`.
- Avoids forcing eBay-native messages into email tables.

#### `ebay_conversation_classifications`

Purpose: current and historical AI/human classification at conversation level.

Key columns:

- `id`
- `conversation_id`
- `latest_message_id`
- `source`
- `classifier_name`
- `classifier_version`
- `category`
- `subcategory`
- `urgency`
- `priority`
- `needs_reply`
- `confidence`
- `is_current`
- `superseded_at`
- `input_hash`
- `context_hash`
- `evidence`
- `created_at`
- `reviewed_by`
- `reviewed_at`

Relationship:

- Complements `email_message_classifications`.
- Drives conversation inbox counts.

#### `ebay_conversation_drafts`

Purpose: AI/operator reply drafts for eBay conversations.

Key columns:

- `id`
- `conversation_id`
- `reply_to_message_id`
- `classification_id`
- `draft_version`
- `is_current`
- `draft_body_text`
- `draft_status`
- `validation_status`
- `validation_errors`
- `safety_flags`
- `requires_human_review`
- `approved_by`
- `approved_at`
- `rejected_by`
- `rejected_at`
- `operator_notes`
- `prompt_hash`
- `input_hash`
- `context_hash`
- `metadata`

Relationship:

- Reuses logic and safety posture from `email_response_drafts`.
- Should not share the same table unless the table is generalized cleanly.

#### `ebay_message_send_attempts`

Purpose: audit every attempted send and prevent duplicate sends.

Key columns:

- `id`
- `conversation_id`
- `return_case_id`
- `draft_id`
- `provider` (`ebay_commerce_message`, `ebay_post_order_return`, `outlook_relay`, `ebay_deep_link`)
- `target_conversation_id`
- `target_return_id`
- `reply_to_message_id`
- `idempotency_key`
- `attempt_status` (`pending_approval`, `approved`, `sending`, `sent_unconfirmed`, `sent_confirmed`, `failed`, `cancelled`)
- `approved_by`
- `approved_at`
- `sent_by`
- `sent_at`
- `provider_message_id`
- `provider_response`
- `error_code`
- `error_message`
- `confirmed_at`
- `confirmation_source`
- `metadata`

Relationship:

- Required before any real send.
- Shared by Commerce Message API, Post-Order send, Outlook relay, and deep-link actions.

#### `ebay_message_sync_runs`

Purpose: read-only and later incremental sync audit for Commerce Message API.

Key columns:

- `id`
- `mode`
- `conversation_type`
- `status`
- `started_at`
- `finished_at`
- `requested_start_time`
- `requested_end_time`
- `limit`
- `offset`
- `conversations_seen`
- `messages_seen`
- `conversations_upserted`
- `messages_upserted`
- `errors`
- `warnings`
- `raw_payload`

Relationship:

- Mirrors useful `ebay_order_sync_runs` and `ebay_return_sync_runs` style.

#### `ebay_conversation_operational_events`

Purpose: append-only-ish audit events for classification, draft, sync, send, read/unread, deep-link open, and fallback relay.

Key columns:

- `id`
- `conversation_id`
- `conversation_message_id`
- `event_type`
- `initiated_by`
- `initiated_by_email`
- `reason`
- `idempotency_key`
- `payload`
- `created_at`

Relationship:

- Avoids overloading `email_operational_events`.

### Return Message Integration

Two viable designs:

1. Keep `ebay_return_messages` as the physical table for return message timelines, and expose returns in the conversation inbox through a view/adaptor.
2. Add `conversation_kind` to `ebay_conversations` and create synthetic/linked return conversations that point to `ebay_return_cases` and `ebay_return_messages`.

Recommendation:

```text
For beta, keep ebay_return_messages as-is and create a conversation adaptor/view/service layer.
After Commerce Message API shape is proven, decide whether to physically unify.
```

## Classification and AI Impact

Classification should move from email-first to conversation-first.

Recommended model:

- Run message-level classification for newly imported eBay messages when useful.
- Store current operator-facing category/urgency/needs-reply at conversation level.
- Keep evidence pointing to the specific latest inbound message(s).
- Use existing deterministic matcher concepts, but apply them to `ebay_conversation_messages`.
- Keep email classifications only for Outlook fallback and non-eBay email.
- Avoid reclassifying duplicate Outlook notifications and eBay-native messages as separate customer events.

The useful existing AI components:

- Category taxonomy and urgency rules.
- Draft safety policy.
- Human review state.
- Staleness detection.
- Verified buyer/order/return context builder.
- Draft validation that blocks unverified claims.
- Operational diagnostics.

Needed changes:

- Add eBay conversation input builders.
- Add provider/source type to classification and draft code, or create eBay-specific functions that share prompt/safety modules.
- Use conversation context hashes instead of email body hashes.
- Classify the clean eBay message body rather than eBay notification text.
- Counts in UI should count conversations, not emails.

## UI and Product Direction

The canonical first screen should no longer be Outlook mailbox.

Recommended default UI:

```text
eBay Conversations
```

### Default Inbox Row

Each row should represent one eBay conversation or return conversation:

- Buyer username or platform sender.
- Conversation title or listing cue.
- Linked order/return/item cue.
- Latest clean message snippet.
- Latest activity timestamp.
- eBay unread count/status.
- AI category.
- Urgency/priority.
- Needs-reply indicator.
- Source badge: `eBay message`, `Return`, `Outlook fallback`, `Notification evidence`.
- Context freshness warning.

### Detail View

Conversation detail should show:

- Clean eBay-native chat timeline.
- Return message timeline when the conversation is a return case.
- Buyer/order/return context cards.
- Related active orders/returns for the same buyer.
- AI classification and rationale.
- Draft composer/review controls.
- Send attempt history.
- Operator notes/tasks.
- Collapsible Outlook notification evidence.
- Deep links to eBay and Outlook when available.

### Tabs

Recommended tabs:

- `Conversations` - canonical eBay-first inbox.
- `Returns` - return-specific work queue and return communication context.
- `Email Evidence` - Outlook notifications and non-eBay email.
- `Ops` - sync runs, OAuth status, stale context, send attempts, errors.

### Work To Pause

Pause:

- Outlook body cleanup as a primary chat renderer.
- Further mailbox-list polish as the primary eBay operator queue.
- Phase B safe sending as Outlook-primary.
- 5F.6 eBay Message Log Panel if it means rendering Outlook blobs.

Redefine:

- 5F.6 as an eBay-native conversation timeline panel.
- Phase B Safe Sending as eBay API send with shared send-attempt audit and Outlook fallback.
- Email Triage as eBay Messaging + AI Ops, with Email View as secondary.

## Read-Only Commerce Message API Capability Probe

Next proof step should be read-only and no-migration if possible.

### Goals

Verify:

- Can the current keyset/token request `commerce.message`?
- Does the current refresh token already include the scope?
- Does eBay return real OG conversations for `FROM_MEMBERS`?
- Does eBay return `FROM_EBAY` conversations?
- Do returned conversations include recent manual test messages?
- Does `getConversation` return clean timeline bodies?
- Are sender/recipient usernames reliable enough for direction?
- Does unread count/read status match eBay UI?
- Are timestamps reliable?
- Are listing references present?
- Are media entries present?
- Can conversations be correlated to `ebay_orders`, `ebay_order_lines`, `ebay_return_cases`, and Outlook notifications?

### Recommended Probe Shape

Create a future admin-only Edge Function, tentatively:

```text
ebay-message-probe
```

Inputs:

- `dryRun: true`
- `conversationType: FROM_MEMBERS | FROM_EBAY`
- `limit`
- `startTime`
- `endTime`
- optional `otherPartyUsername`
- optional `referenceId`
- optional `includeDetails`

Behavior:

- Mint an access token with `EBAY_MESSAGE_SCOPE` defaulting to `commerce.message`.
- Fetch a small page of conversations.
- Optionally fetch details for a few conversation ids.
- Redact/compact returned bodies in the probe response if needed.
- Do not persist message bodies in first probe unless explicitly approved.
- Do not send.
- Do not mark read/unread.
- Do not create migrations.

Outputs:

- scope refresh success/failure category,
- conversations count,
- sample field coverage,
- detail field coverage,
- correlation candidates,
- warnings,
- required reconnect/setup steps.

### Probe Decision Gate

Only after the probe succeeds should the team create migrations for:

- `ebay_conversations`
- `ebay_conversation_messages`
- `ebay_conversation_links`
- `ebay_message_sync_runs`

If the probe fails because the scope is missing, the next step is OAuth reconnect, not more Outlook parsing.

## Safe Sending Reassessment

Assume eBay-first.

Recommended long-term send order:

1. eBay Commerce Message API send for normal member conversations.
2. eBay Post-Order `send_message` for return conversations.
3. Outlook relay reply fallback when eBay API send is unavailable or not yet approved.
4. eBay deep-link fallback as last-resort beta/manual action.

### Direct Commerce Message API Send

Use for:

- Normal buyer/member messages.
- Existing conversations by `conversationId`.
- New listing-related buyer messages by `otherPartyUsername` plus listing reference, if product supports starting conversations.

Needs:

- `commerce.message` scope.
- Send attempt table.
- Draft approval.
- Idempotency key.
- Pre-send latest conversation refresh.
- Max length validation.
- Optional media handling.
- Post-send detail sync to confirm provider message id.

### Post-Order Return Send

Use for:

- Return-case messages tied to `returnId`.

Needs:

- Confirm existing token can call send endpoint.
- Send attempt table.
- Follow-up return sync because the endpoint has no response payload.
- Post-send confirmation by imported `ebay_return_messages` or return detail/history.

### Outlook Relay Fallback

Use for:

- Temporary fallback while eBay send is not implemented.
- Cases where Commerce Message API does not expose the needed thread.
- Emergency manual bridge when original Outlook notification has a valid relay alias.

Rules:

- Prefer Graph reply to original imported message, not new `sendMail`.
- Require a stored original `email_message_id`.
- Block no-reply/non-relay addresses.
- Confirm later through eBay Message API sync if possible.
- Never treat Outlook accepted/send success as eBay confirmed delivery.

### Deep-Link Fallback

Use for:

- Beta safety before API sends are trusted.
- Returns where the operator should complete an action on eBay page.
- Cases where eBay API scope is blocked.

Rules:

- Log open action only.
- Do not mark sent.
- Confirm later through eBay sync.

## Revised Roadmap

Each step below is intended to be one future Codex prompt.

### 5F.6C - Read-Only Commerce Message API Capability Probe

Purpose:

- Verify keyset, token, scope, and field coverage.

Work:

- Add admin-only read-only probe function.
- Use `EBAY_MESSAGE_SCOPE`.
- Fetch small `FROM_MEMBERS` and `FROM_EBAY` samples.
- Fetch details for selected conversations.
- No sends, no migrations, no persistence unless explicitly approved.

Expected team needs:

- Confirm/possibly add `EBAY_MESSAGE_SCOPE`.
- Possibly reconnect OAuth with `commerce.message`.
- Confirm hosted function config/deployment path.

### 5F.6D - eBay Messaging Schema Design and Migration Plan

Purpose:

- Convert probe findings into final schema.

Work:

- Draft migrations for conversation/message/link/sync-run tables.
- Include RLS and admin/operator policies.
- Include migration drift strategy.
- Do not push until reviewed.

Expected migrations:

- Required if probe succeeds.

### 5F.6E - Read-Only eBay Conversation Sync

Purpose:

- Persist conversations and messages.

Work:

- Build idempotent sync.
- Store conversation headers and message timelines.
- Store sync runs.
- No send behavior.

Expected deploy:

- Edge Function deploy after code review.

### 5F.6F - Conversation Linker and Context Builder

Purpose:

- Link eBay conversations/messages to orders, order lines, returns, inventory, and Outlook evidence.

Work:

- Reuse deterministic matcher concepts.
- Add conversation links.
- Add buyer/order/return context builder for eBay conversations.

Expected migrations:

- Link table/indexes if not already created.

### 5F.6G - eBay-First Conversation Inbox UI

Purpose:

- Replace Outlook mailbox as primary eBay operator surface.

Work:

- Build default conversation list.
- Add clean timeline.
- Add buyer/order/return cards.
- Add source badges and stale context warnings.
- Add Email Evidence tab only as secondary.

Paused/replaced:

- Outlook mailbox polish as primary eBay queue.

### 5F.6H - Conversation-Level AI Classification

Purpose:

- Run AI classification on eBay-native conversations/messages.

Work:

- Add conversation classification table/function.
- Reuse taxonomy and safety logic.
- Compute needs-reply and urgency at conversation level.

### 5F.6I - eBay Conversation Drafts

Purpose:

- Generate safe reply drafts for eBay-native conversations.

Work:

- Add conversation draft table/function.
- Reuse verified context and draft validation.
- Keep human review required.

### 5F.6J - Send Attempt Audit Foundation

Purpose:

- Add send attempt data model before any send.

Work:

- Add `ebay_message_send_attempts`.
- Add idempotency, approval, failure, confirmation states.
- Add UI send-history panel.
- No actual sends yet.

### 5F.6K - Controlled Commerce Message API Send

Purpose:

- Send normal eBay conversation replies through eBay API.

Work:

- Implement send for approved drafts only.
- Require pre-send sync refresh.
- Confirm by post-send `getConversation`.
- Manual tests with known buyer.

### 5F.6L - Controlled Post-Order Return Send

Purpose:

- Send return-case replies through Post-Order API.

Work:

- Implement return send attempts.
- Confirm through return sync/history.
- Manual tests in Production because Post-Order send is not Sandbox-supported.

### 5F.6M - Outlook Relay and Deep-Link Fallback

Purpose:

- Keep fallback paths without making Outlook canonical.

Work:

- Implement Graph reply only if needed.
- Add deep-link open actions.
- Confirm through eBay sync.

Expected OAuth:

- Microsoft reconnect with `Mail.Send` only if Outlook relay fallback is needed.

### Phase Rename Recommendation

Rename the workstream:

```text
Old: OG Email Triage
New: OG eBay Messaging AI Ops
```

Keep `Email Triage` as a submodule for Outlook/non-eBay messages and fallback evidence.

## Migration Impact

No migrations were modified in this audit.

Future migrations are likely required if eBay-first is accepted:

| Migration need | Timing | Risk |
| --- | --- | --- |
| eBay conversation/message/sync-run tables | After read-only probe succeeds | Medium; new isolated tables reduce drift risk. |
| Conversation links/classifications/drafts | After canonical sync shape is proven | Medium; must avoid duplicating email-only assumptions. |
| Send attempts | Before any send implementation | High safety importance; should be reviewed carefully. |
| eBay account/token connection tables | Recommended before production messaging, required for multi-account/reconnect hygiene | Medium-high; security-sensitive. |
| RLS/admin/operator policies | With each new table | High if rushed. |
| Email table deprecation/migration | Not immediate | Low priority. Do not delete data. |

Repo-specific migration warning:

```text
A Supabase migration mismatch does not automatically mean the database is missing functionality.
```

Do not run `db push --include-all` casually. For the eBay-first pivot, prefer narrow additive migrations after the probe.

## Current Work That Remains Valuable

Outlook/Email Triage work that remains useful:

- Microsoft Graph connection and import for fallback evidence.
- Email persistence for non-eBay and audit.
- Deterministic matching ideas.
- `email_message_links` as a model for auditable linking.
- AI classification taxonomy and urgency logic.
- Draft generation and validation guardrails.
- Human approval/rejection UX.
- Stale context warnings.
- Buyer/order/return context cards.
- Operational dashboard ideas.
- Pagination/category/sorting lessons.
- Manual reply test proof that Outlook relay can work as fallback.

Existing eBay work that becomes central:

- `ebay-order-sync`
- `ebay-return-sync`
- `ebay-buyer-history-sync`
- `ebay_return_messages`
- `ebay_orders`
- `ebay_order_lines`
- `ebay_return_cases`
- `ebay_buyer_history_syncs`
- `ebay_account_history_sync_runs`
- `get_ebay_buyer_insights`
- Return message log rendering.
- Page-transfer event patterns.
- Order/return task event trails.

## Work To Pause, Deprecate, Or Reframe

Pause:

- Outlook-first UI polish.
- Outlook notification body parsing as chat.
- Outlook-primary safe sending.
- 5F.6 message log panel if it is Outlook-derived.

Deprecate over time:

- Individual Outlook email row as the main eBay work item.
- Outlook `conversation_id` as eBay conversation identity.
- Email-only classification/draft/send tables for eBay communications.
- Direct operator reliance on messy notification body rendering.

Reframe:

- `Email Triage` becomes a fallback/non-eBay/email evidence layer.
- `message_detail` work becomes reusable UI/context pattern, not final eBay detail source.
- `email_message_links` becomes a predecessor to provider-neutral/eBay conversation links.
- `email_response_drafts` becomes a predecessor to conversation drafts.

## Risks and Unknowns

High-priority unknowns:

- Whether active Production keyset exposes `commerce.message`.
- Whether current refresh token includes `commerce.message`.
- Whether Message API returns all real seller/buyer conversations OG expects.
- Whether Message API conversations include Outlook-relay-sent replies.
- Whether unread status maps cleanly to native eBay UI.
- Whether listing references are enough to link pre-sale messages to inventory/order context.
- Whether normal buyer messages and return messages can be cleanly unified in UI without confusing send semantics.
- Whether current public unauthenticated eBay sync functions should be hardened before adding messaging endpoints.
- Whether existing `EBAY_REFRESH_TOKEN` belongs to the correct seller account and environment.

Implementation risks:

- Duplicating eBay token-refresh code again instead of centralizing.
- Building migrations before probe results are known.
- Treating Post-Order return messages as identical to normal member conversations.
- Sending before idempotency and confirmation are built.
- Overexposing buyer value/profitability context in buyer-facing drafts.
- Losing auditability when transitioning from email rows to conversation rows.

## Recommended Next Executable Step

Run:

```text
Step 5F.6C - Read-Only Commerce Message API Capability Probe
```

The prompt should ask Codex to:

- Inspect current eBay secrets by name only, not value.
- Add or design an admin-only read-only probe.
- Request `commerce.message` through a dedicated `EBAY_MESSAGE_SCOPE`.
- Fetch `FROM_MEMBERS` and `FROM_EBAY` samples.
- Fetch details for a few conversations.
- Compare returned data shape to recent manual Outlook relay test.
- Report whether OAuth reconnect is required.
- Perform no sends.
- Perform no migrations unless explicitly approved later.

If the probe confirms access, the next phase is schema design and read-only sync. If it fails due to missing scope, the next phase is eBay OAuth reconnect/setup, not more Outlook work.

## Final Recommendation

1. eBay-first is now recommended.
2. Outlook should eventually disappear from the canonical eBay messaging workflow if Commerce Message API and Post-Order send are proven.
3. Outlook should remain temporarily as fallback, notification evidence, relay backup, and non-eBay email coverage.
4. Existing eBay infrastructure is highly reusable for context, sync patterns, OAuth refresh patterns, return message logs, order/return/buyer data, and task/event audit patterns.
5. Existing eBay infrastructure is not sufficient by itself for Commerce Message API until `commerce.message` scope, keyset availability, and token consent are verified.
6. The current database should not be stretched further around Outlook. Add eBay conversation/message/link/classification/draft/send-attempt tables after the read-only probe succeeds.
7. The operator UI should become eBay conversation-first, with Outlook Email Evidence secondary.
8. Safe sending should be eBay API first, Post-Order API for returns, Outlook relay fallback, and deep-link fallback last.
9. The lowest-risk beta path is read-only Commerce Message API verification, then read-only eBay conversation sync, then conversation UI/classification/drafts, then send attempt audit, then controlled sends.
10. Do not continue the project as Outlook-primary.
