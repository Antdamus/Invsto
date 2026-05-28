# Step 5F.6A eBay Messaging + Reply Architecture Audit

Audit date: 2026-05-28

Scope: high-depth architecture audit only. No production logic, migrations, deploys, eBay mutations, Outlook mutations, or Supabase repair actions were performed.

## Executive Summary

The recommended long-term architecture is **hybrid**, with **eBay-native conversation data as the canonical source for eBay buyer conversations where accessible**, **Outlook as notification ingestion, relay/send fallback, and non-eBay mailbox coverage**, and **Supabase as the normalized operational intelligence layer**.

The manual reply test is important: replying from Outlook to an anonymized eBay `@members.ebay.com` relay address can route back into the real eBay chat. That means Outlook is not invalid as a send transport. It does not mean Outlook should remain the primary conversation source.

The desired operator experience is conversation-centric: one row per buyer/conversation, clean message timeline, unread state, buyer/order/return context, AI triage, draft review, safe sending, and audit trail. Outlook notification emails alone are too noisy and lossy to be the durable source of truth for that experience. Outlook-only grouping and parsing can support a beta approximation, but it will remain fragile because notification emails are event wrappers, not the actual eBay conversation model.

Official eBay documentation changes the answer materially. The eBay Message API supports retrieving conversations, retrieving messages inside a conversation, unread/status information, status updates, and sending messages in new or existing conversations through `https://api.ebay.com/commerce/message/v1`. The Post-Order API also supports return message retrieval through return detail/history payloads and direct return-case messaging through `POST /post-order/v2/return/{returnId}/send_message`. The repo already uses the Post-Order return API and stores/imports return message logs, but it does not yet use the Commerce Message API for normal buyer/member conversations.

Final recommendation:

1. Do not continue Outlook-primary as the long-term architecture.
2. Do not pivot to pure eBay-primary because Outlook remains valuable for notifications, fallback send, non-eBay email, and correlation/audit.
3. Build a normalized conversation layer and make eBay Message API/Post-Order messages canonical for eBay chat where available.
4. Use Outlook relay replies as a validated fallback transport, not the first-choice canonical eBay reply path.
5. Redesign Phase B Safe Sending around eBay API send first, Outlook relay second, eBay deep-link third.

## Why This Audit Was Needed

The Email Triage work has made Outlook/Microsoft Graph ingestion operationally useful. Imported Outlook emails can be persisted, normalized, matched to stored eBay/order/return context, classified, paginated, reviewed, and enriched with buyer/order/return cards. The current detail panel now returns conversation metadata, thread blocks, recipients, warnings, and `matched_context`.

However, manual UI testing exposed a product mismatch. The current Outlook body often contains one large eBay notification blob: quoted prior messages, eBay legal text, repeated buyer/seller content, order widgets, footers, and HTML layout artifacts. Rendering that blob more cleanly helps, but it does not produce a native eBay chat timeline.

The new manual reply test also changed the architectural question. Outlook relay sending may work, so the problem is no longer "can Outlook send?" The problem is "what should be the canonical source for the operator conversation view and safe reply workflow?"

## Manual Reply Test Finding

A personal eBay account messaged the OG Jewelers eBay account. Outlook received an eBay notification from an anonymized relay identity like:

```text
eBay - <buyer_username> <...@members.ebay.com>
```

Replying directly through Outlook to that `@members.ebay.com` address successfully appeared inside the real eBay chat.

Implications:

- Outlook relay replies are viable enough to keep in the architecture.
- The app should not send a new standalone email to a copied relay alias when it can reply to the original imported Outlook message.
- If Outlook relay is used, the safer route is Microsoft Graph `reply` or `createReply` from the original `email_messages.provider_message_id`, preserving reply headers and mailbox threading.
- Relay delivery still needs real-world validation across message age, alias expiry, no-reply variants, item/order contexts, attachments, buyer privacy rules, and eBay account policy changes.
- Outlook relay success does not solve conversation grouping, unread state, canonical timestamps, deduplication, or clean chat rendering.

## Current Outlook Architecture Assessment

Current frontend files reviewed:

- `email-triage.html`
- `email-triage.js`
- `email-triage.api.js`
- `email-triage.css`

Current Microsoft/Email Triage backend files reviewed:

- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/functions/microsoft-email-ops/index.ts`
- `supabase/functions/_shared/deterministic-email-matcher.ts`

Current tables reviewed:

- `email_mailboxes`
- `email_messages`
- `email_message_bodies`
- `email_message_recipients`
- `email_message_links`
- `email_message_classifications`
- `email_response_drafts`
- `email_processing_jobs`
- `email_sync_runs`
- `email_sync_states`
- `email_operational_events`

What Outlook currently does well:

- It captures real eBay notification events without new eBay-message OAuth scope.
- It captures non-eBay customer, vendor, internal, and marketplace emails.
- Microsoft Graph import persists stable mailbox metadata: provider ids, immutable ids, `internet_message_id`, Outlook `conversation_id`, `conversation_index`, subject, participants, read state, body preview, body content, `web_link`, timestamps, and Graph change metadata.
- Durable sync and bounded mailbox import can scale beyond the early 25-message preview toward 100, 300, and 1000 rows.
- `microsoft-email-sync` classifies likely eBay emails using eBay sender domains, text patterns, order numbers, return language, and relay email patterns.
- `microsoft-email-process` and `_shared/deterministic-email-matcher.ts` normalize text and create deterministic links to eBay orders, order lines, returns through metadata, inventory, sales, and buyer identity.
- `microsoft-email-classify` handles AI classification, draft generation, draft validation, match context, stale context warnings, and selected `message_detail`.
- `message_detail` now returns Outlook conversation metadata, up to 50 stored same-`conversation_id` messages, thread blocks, recipients, body source warnings, classification staleness, and stored eBay `matched_context`.
- The UI already has useful category navigation, pagination, operational dashboard, context cards, draft review, and match review surfaces.

What Outlook cannot do well by itself:

- It cannot guarantee one canonical eBay conversation row per buyer/item/conversation because Outlook emails are notifications, not the eBay conversation resource.
- It cannot reliably recover seller-side messages unless those messages generate Outlook notifications or Sent Items are imported and correlated.
- It cannot guarantee eBay unread state. Outlook `is_read` is mailbox read state, not eBay conversation read/unread state.
- It cannot guarantee eBay conversation status such as active, archived, deleted, read, or unread.
- It cannot reliably strip eBay notification wrappers into clean buyer/seller chat messages across template changes.
- It cannot reliably deduplicate quoted messages embedded in later notification bodies.
- It cannot reliably map Outlook `conversation_id` to eBay conversation identity. Outlook conversation grouping is mail-thread oriented and can split or merge differently from eBay.
- It cannot guarantee that the `@members.ebay.com` alias remains valid for later sends, across all message types, or after alias rotation.
- It cannot confirm that a relay reply appeared in eBay unless a later eBay notification or eBay-native message sync verifies it.

Current Outlook send posture:

- Existing Microsoft OAuth scopes default to `offline_access Mail.Read User.Read`.
- No inspected Email Triage function currently sends, replies, deletes, moves, marks read, or mutates Outlook.
- Microsoft Graph officially supports `POST /me/messages/{id}/reply` with `Mail.Send`; if the original message has `replyTo`, the reply should be addressed to `replyTo` rather than `from`.
- Microsoft Graph `createReply` creates a draft reply but requires `Mail.ReadWrite`.
- Microsoft Graph `sendMail` can send new mail with `Mail.Send`, but a new email is less desirable for eBay relay because it may not preserve the original reply chain.

Which Outlook parts remain useful under eBay-primary or hybrid:

- Microsoft OAuth connection and Graph import remain useful.
- `email_messages`, `email_message_bodies`, recipients, sync states/runs, and operational events remain useful for notifications, fallback, audit, and non-eBay email.
- `email_message_links` and deterministic matching remain useful as a correlation layer between Outlook notifications and eBay/order/return data.
- `email_message_classifications` and `email_response_drafts` remain useful patterns, but should be generalized or complemented for conversation-level classification.
- The buyer/order/return context cards should stay.
- Operational dashboards, stale context warnings, draft validation, and human approval flows should be reused.

## Outlook-Only Conversation UI Feasibility

Can an eBay-like conversation inbox be built from Outlook data alone?

Short answer: **not correctly as the long-term source of truth**. It can be approximated for beta with known caveats.

Outlook-only grouping strategies:

| Strategy | Feasibility | Risk |
| --- | --- | --- |
| Outlook `conversation_id` | Useful for email-thread grouping | Not equivalent to eBay conversation; can miss separate eBay notification events or merge unrelated email replies. |
| `@members.ebay.com` alias | Useful send/reply hint | Alias may be per-message or relay-context scoped; not guaranteed to be stable identity. |
| Buyer username from subject/display name | Useful for grouping candidates | One buyer can have multiple active orders/items/returns; username-only grouping over-merges. |
| Item ID/listing ID | Useful for listing conversations | Many notifications lack clean item ID, and one buyer can ask multiple item questions. |
| Order number/transaction ID | Strong when present | Normal pre-sale buyer messages may not have an order; notifications may omit transaction IDs. |
| eBay email reference ID | Potentially useful if present | Current pipeline does not store a first-class eBay reference id from headers/body. |
| `email_message_links` | Strong for context | Links identify order/item/customer context, not exact message chronology. |
| Body parsing | Can extract snippets | Brittle because eBay notification templates include repeated content, footers, quoted text, widgets, policy text, and HTML artifacts. |

Outlook-only parsing challenges:

- eBay notifications often include "latest message" plus quoted earlier thread content.
- Buyer and seller messages can both appear in a single notification body.
- Timestamps in notification bodies are inconsistent, hidden in HTML, localized, or absent.
- Direction inference can be wrong when sender is `ebay.com`, `reply.ebay.com`, or a masked relay.
- Footers and policy text can look like message content.
- Legal disclaimers and notification controls can pollute classification.
- Deduplication by normalized body text can remove real repeated short messages or retain quoted duplicates.
- Outlook read/unread state can diverge from eBay read/unread state.

Beta feasibility:

- A conversation-view beta could group imported Outlook messages by a synthetic key such as `buyer_username + item_id/order_number/return_id + relay sender + subject family`, show one row per group, and display cleaned latest snippets.
- It should clearly label the thread as "Outlook notification-derived" and provide an "Open in eBay" or "Open in Outlook" fallback.
- It should avoid claiming a complete eBay chat timeline.

Long-term feasibility:

- Outlook-only is not recommended. It will keep spending engineering effort on template reverse-engineering while still missing canonical eBay fields that the eBay Message API already provides.

## Existing Repo eBay Messaging Findings

Current eBay files reviewed:

- `ebay-returns.html`
- `ebay-order-history.html`
- `pending-orders.html`
- `ebay-order-history.js`
- `ebay-buyer-insights.js`
- `pending-orders.js`
- `supabase/functions/ebay-return-sync/index.ts`
- `supabase/functions/ebay-order-sync/index.ts`
- `supabase/functions/ebay-buyer-history-sync/index.ts`
- `supabase/functions/ebay-inventory-sync/index.ts`

Current eBay migrations reviewed include:

- `ebay_return_messages`
- `ebay_return_cases`
- `ebay_return_items`
- `ebay_return_events`
- `ebay_return_tasks`
- `ebay_return_task_events`
- `ebay_orders`
- `ebay_order_lines`
- `ebay_buyer_history_syncs`
- `ebay_account_history_sync_runs`

How the return tab gets eBay message logs:

- `ebay-return-sync` uses the eBay Post-Order API to search returns, fetch return detail with `fieldgroups=FULL`, fetch return files, and import return-related messages into `ebay_return_messages`.
- `responseHistoryMessages()` extracts buyer creation comments, response history entries, and page-model history/message summary content when available.
- Imported messages are inserted into `ebay_return_messages` with `channel = 'ebay_return_api'`, `message_status = 'imported'`, direction, body, sent timestamp, return id, order number, buyer username, and metadata.
- `ebay-order-history.js` also has browser/extension transfer logic that records messages typed/sent through the eBay return page using `record_ebay_return_message_log`.
- Manual/page logs default to `message_status = 'sent_from_ebay_page_unverified'`, which is explicitly an audit context, not guaranteed delivery confirmation.
- The return UI renders an "eBay Message Log" by combining stored `ebay_return_messages` with messages parsed from task payload metadata, deduplicating by return id, direction, and normalized body.

Reliability assessment:

- Return message direction is often reliable when coming from structured API author/role fields or explicit browser-transfer direction, but some page-model history directions are inferred from title text such as "you sent" or "buyer sent".
- Return message timestamps are usually reliable when coming from API date fields; some fallback to sync time, task update time, or current time.
- Message bodies are much cleaner than Outlook notification blobs because they come from return API fields or return page model fields, but page-model extraction still needs source labels and caveats.
- Return messages are separate from normal buyer/member messages. They live under the Post-Order return domain and should not be treated as normal eBay member conversations.
- Existing code does not send return messages from the app through eBay API. It logs messages sent elsewhere and imports messages from return sync.
- Existing code does not collect normal buyer/member eBay conversations through the Commerce Message API.

Existing structure that helps an eBay-primary conversation inbox:

- `ebay_return_messages` already proves the repo can store eBay-native-ish direction, timestamp, body, channel, status, and related return/order/buyer identifiers.
- The return UI already proves the product value of a clean chat-like log.
- `ebay_orders`, `ebay_order_lines`, returns, buyer history syncs, and buyer insights already provide context for conversation enrichment.
- The missing piece is a normal buyer/member conversation sync and normalized conversation table model.

## eBay Official API Capability Findings

Official sources reviewed:

- eBay Message API overview: https://developer.ebay.com/api-docs/commerce/message/overview.html
- eBay Message API `getConversations`: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/getConversations
- eBay Message API `getConversation`: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/getConversation
- eBay Message API `sendMessage`: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/sendMessage
- eBay Post-Order `GET /return/{returnId}`: https://developer.ebay.com/Devzone/post-order/post-order_v2_return-returnid__get.html
- eBay Post-Order `GET /return/{returnId}/files`: https://developer.ebay.com/Devzone/post-order/post-order_v2_return-returnId_files__get.html
- eBay Post-Order `POST /return/{returnId}/send_message`: https://developer.ebay.com/devzone/post-order/post-order_v2_return-returnid_send_message__post.html
- eBay Fulfillment `getOrders`: https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders
- Microsoft Graph message resource: https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
- Microsoft Graph message reply: https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0
- Microsoft Graph createReply: https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0
- Microsoft Graph sendMail: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0

Normal buyer/member messages:

- eBay Message API supports retrieving conversations associated with the authenticated user.
- `getConversations` requires `conversation_type`, with valid values including `FROM_MEMBERS` and `FROM_EBAY`.
- It supports filtering by conversation status, listing reference, other party username, and for `FROM_MEMBERS`, start/end time.
- Conversation list payload includes `conversationId`, status, title, type, created date, latest message, listing reference id/type where present, and `unreadCount`.
- `getConversation` retrieves messages in a specific conversation and returns message body, message id, created date, media, read status, sender username, recipient username, subject, pagination, and conversation status/title/type.
- `sendMessage` can start a new conversation with `otherPartyUsername` or send in an existing conversation with `conversationId`.
- `sendMessage` requires `messageText`, allows optional media and listing reference, supports sandbox, and requires `https://api.ebay.com/oauth/api_scope/commerce.message`.
- `messageText` max length is documented as 2000 characters.

Return/post-order messages:

- Post-Order `GET /post-order/v2/return/search` retrieves returns by date/status/type/listing/order/transaction filters.
- Post-Order `GET /post-order/v2/return/{returnId}?fieldgroups=FULL` retrieves return detail, including buyer login, files, close info, and detailed return payload fields.
- Post-Order `GET /post-order/v2/return/{returnId}/files` retrieves files associated with a return request.
- Post-Order `POST /post-order/v2/return/{returnId}/send_message` sends a message to the order partner regarding a return request.
- Post-Order return endpoints are documented as not supported in Sandbox.
- The repo already uses return search, detail, files, and history extraction, but does not yet call return `send_message`.

Order-related messaging:

- Fulfillment `getOrders` returns buyer, seller, line item, fulfillment, shipping, payment, and monetary data.
- Fulfillment order APIs are excellent for order context but are not a communication-history API.
- Order data can help link messages to buyers/items/orders but should not be treated as the message source of truth.

Legacy Trading API:

- Trading `GetMemberMessages` and `AddMemberMessageRTQ` exist for older Ask Seller Question flows.
- `AddMemberMessageRTQ` is specifically framed as sellers replying to buyer questions about active listings and has a documented short-duration burst limit of 75 calls per seller user ID per 60 seconds.
- Given the modern Commerce Message API surface, the legacy Trading APIs should be fallback research only, not the preferred new architecture.

## Return Messaging vs Normal Buyer Messaging

Return messaging and normal buyer/member messaging should be modeled separately but surfaced together in one operator console when context links justify it.

Return messages:

- Source: eBay Post-Order API and return page/browser-transfer logs.
- Primary entity: `ebay_return_id` / `ebay_return_cases`.
- Context: return reason, return state, action due, files/photos, refund/request amount, tracking, intake tasks.
- Send path: Post-Order `send_message` where implemented and authorized.
- Existing local table: `ebay_return_messages`.

Normal buyer/member messages:

- Source: eBay Commerce Message API.
- Primary entity: `conversationId` with `conversation_type = FROM_MEMBERS`.
- Context: other party username, listing reference, message ids, media, unread count, read status.
- Send path: Commerce Message API `send_message`.
- Existing local table: none yet.

They can be unified at the UI/conversation layer by type:

- `ebay_member_conversation`
- `ebay_return_conversation`
- `outlook_notification_thread`
- `non_ebay_email_thread`

But they should not be forced into one physical table until the identity and send semantics are explicit.

## Reply/Send Capability Analysis

### Direct eBay API Send

Normal buyer/member messages:

- Possible through eBay Commerce Message API `sendMessage`.
- Required scope: `https://api.ebay.com/oauth/api_scope/commerce.message`.
- Existing repo OAuth helpers do not currently default to this scope.
- Existing eBay functions do not call this API.
- Needs production keyset/scope availability validation because eBay docs instruct checking available OAuth scopes on the Application Keys page.

Return messages:

- Possible through Post-Order `POST /post-order/v2/return/{returnId}/send_message`.
- Existing `ebay-return-sync` has token plumbing for Post-Order return calls but currently only reads/syncs; it does not send.
- Post-Order send has no response payload, so confirmation should be done by a follow-up return detail/message sync and local send-attempt audit status.

Direct API send should use:

- explicit human approval,
- draft version pinning,
- latest context hash,
- idempotency key,
- send attempt table,
- pre-send conversation/return state refresh,
- no automatic retry that can duplicate messages,
- post-send sync confirmation,
- failure states visible to the operator.

### Outlook Relay Send

Outlook relay send is now empirically viable for at least the tested normal buyer message.

If used:

- Prefer Graph `reply` on the original imported message over `sendMail`.
- Require `Mail.Send` and a reconnect flow.
- Use the original `provider_message_id` as the reply target.
- Let Graph honor `replyTo` if present.
- Block no-reply addresses, platform notification-only addresses, missing relay recipients, stale aliases, and messages without an original imported Outlook row.
- Send plain text with minimal/no quoted body. Do not include messy eBay notification HTML.
- Store send attempts separately from drafts.
- Confirm delivery by later eBay Message API sync or a subsequent Outlook/eBay notification.

Risks:

- Relay aliases may expire or be scoped.
- Outlook success only means accepted by Exchange, not necessarily posted to eBay.
- Sending to the wrong relay alias could post into the wrong thread or fail silently.
- It cannot update eBay read/conversation state unless eBay later reports it.

### eBay Deep-Link Reply

Deep-link reply remains useful as a beta fallback:

- Store `web_link` for Outlook and any extracted eBay return/conversation page URLs.
- For returns, the repo already stores return `detailsUrl`/page URLs in metadata and renders "Open eBay" links in return workflows.
- For normal buyer messages, reply URLs may be extractable from eBay notification HTML, but that extraction should be treated as brittle.
- Opening a deep link can be logged as an operator action but not treated as a sent reply.
- Later eBay sync should verify whether a message appeared.

Recommendation:

- Primary send for normal eBay messages: eBay Commerce Message API.
- Primary send for return messages: eBay Post-Order `send_message`.
- Fallback send: Outlook relay reply through Graph `reply`.
- Last-resort beta fallback: eBay deep-link open with audit event and later sync verification.

## Architecture Options Compared

### Option A - Outlook-primary email inbox

Flow:

```text
Outlook imports eBay notification emails
App classifies individual emails
App replies through Outlook to eBay relay alias
eBay relay posts reply into eBay Messages
```

Assessment:

- Feasible now for ingestion and classification.
- Manual test proves relay reply can work.
- Fastest to keep iterating in the current codebase.
- Does not solve the canonical conversation UI problem.
- Continues to rely on noisy notification body parsing.
- Cannot reliably model eBay unread state, conversation status, full clean timeline, or seller-side sent messages.
- Acceptable only as a beta fallback path, not the long-term architecture.

### Option B - Outlook transport + normalized conversation layer

Flow:

```text
Outlook imports eBay notification emails
App extracts buyer/item/order/message snippets
App normalizes into conversation rows
UI shows one row per buyer/item/order conversation
Replies are sent through Outlook relay alias
App records sent replies and later confirms via notification or sync
```

Assessment:

- Better than Option A for UI.
- Can reduce mailbox clutter.
- Useful as an intermediate if eBay Message API scope is delayed.
- Still depends on brittle parsing for canonical message bodies and chronology.
- Would require normalized conversation tables anyway.
- Should not be the final target if eBay Message API works for the seller account.

### Option C - eBay-primary messaging

Flow:

```text
eBay APIs import buyer conversations
App stores normalized eBay conversation/message tables
App classifies eBay messages directly
App displays eBay-style chat thread
App sends replies through eBay APIs where possible
Outlook becomes optional notification backup
```

Assessment:

- Best fit for the desired eBay-like chat UI.
- Provides canonical eBay conversation id, message ids, direction by sender/recipient username, unread count/read status, listing reference, media, and clean body text.
- Requires eBay OAuth scope changes and new sync/send implementation.
- Does not cover non-eBay email and should not discard Outlook work.
- Slightly too narrow as the whole product architecture.

### Option D - Hybrid source of truth

Flow:

```text
Outlook = notification source, relay fallback, non-eBay email
eBay = canonical eBay conversation and return message source where available
Supabase = normalized operational intelligence layer
```

Assessment:

- Best long-term fit.
- Lets the operator see one conversation row while preserving evidence from both sources.
- Avoids over-investing in Outlook notification parsing.
- Keeps existing Outlook import/classification/context work useful.
- Requires careful deduplication and source labels.
- Requires a normalized eBay conversation model and send-attempt audit model.

Recommendation: choose Option D.

## Conversation Inbox Design Recommendation

The current mailbox list should not remain the only primary operator view.

Recommended UI model:

- Default tab: `Conversations`
- Secondary tab: `Email View`
- Secondary tab or filter: `Returns`
- Diagnostics/admin tab: `Import / Ops`

Conversation row should show:

- buyer username or best available identity,
- conversation title/listing/order/return cue,
- latest clean message snippet,
- latest activity time,
- unread/new count from eBay where available,
- needs-reply state,
- urgency/category,
- linked order/return/item indicators,
- source badges such as `eBay`, `Return`, `Outlook fallback`, `Notification only`,
- stale context warning when eBay/order sync is old.

Conversation detail should show:

- clean eBay-native message timeline first,
- return message log if linked,
- Outlook notification evidence in a collapsible secondary panel,
- buyer/order/return context cards,
- draft/reply composer and approval controls,
- send attempts and audit trail,
- "Open in eBay" and "Open in Outlook" links.

Multiple active orders/conversations for one buyer:

- Do not collapse all messages by buyer alone.
- Group primarily by eBay `conversationId` or return id.
- Show buyer-level rollup only as a sidebar/context summary.
- If several active conversations share a buyer, render separate rows and let the buyer summary identify related active orders/returns.

Classification counts:

- Conversation view should count conversations, not individual Outlook emails.
- A conversation can expose the latest conversation-level classification plus message-level classifications in history.
- Category counts should be derived from the current conversation classification state.

## Recommended Architecture

Use a hybrid architecture with clear source roles:

```text
eBay Commerce Message API
  -> ebay_conversations / ebay_conversation_messages
  -> canonical normal buyer/member chat timeline

eBay Post-Order Return API
  -> ebay_return_cases / ebay_return_messages
  -> canonical return-case communication timeline

Outlook / Microsoft Graph
  -> email_messages / bodies / recipients
  -> notification evidence, fallback relay send, non-eBay mailbox triage

Supabase normalized operational layer
  -> links, classifications, drafts, send attempts, audit events
  -> operator conversation inbox
```

Decision answers:

1. Continue Outlook-primary? No, not for eBay buyer conversations long-term.
2. Pivot to pure eBay-primary? No, because Outlook remains valuable and required for non-eBay email/fallback.
3. Use hybrid? Yes.
4. Build eBay-like chat UI from Outlook alone? Only as a fragile approximation; not recommended as the source of truth.
5. Build normalized conversation layer? Yes.
6. Safe sending? eBay API first, Outlook relay fallback, deep-link fallback.
7. 5F.6 eBay Message Log Panel? Redefine it as a normalized conversation panel, not a panel that tries to parse Outlook blobs into chat.
8. Phase B Safe Sending? Redesign around provider-specific send strategies and a common send-attempt audit model.
9. Current Outlook work? Keep and reuse.
10. Lowest-risk beta path? Validate eBay Message API scope/read POC, then build read-only normalized conversation sync before any send.
11. Best long-term architecture? Hybrid canonical eBay conversations plus Outlook fallback.
12. Immediate next? Run a read-only eBay Message API capability probe and compare it against the manually tested Outlook notification thread.

## Proposed Future Data Model

Do not implement these in this audit. Future migrations should be created only after the eBay Message API capability probe confirms production access.

### `ebay_conversations`

Purpose: canonical normal eBay member/platform conversation header.

Key columns:

- `id`
- `ebay_conversation_id`
- `conversation_type` (`FROM_MEMBERS`, `FROM_EBAY`)
- `conversation_status`
- `conversation_title`
- `other_party_username`
- `latest_message_id`
- `latest_message_at`
- `unread_count`
- `reference_type`
- `reference_id`
- `linked_order_id`
- `linked_order_line_id`
- `buyer_key`
- `source_account`
- `last_synced_at`
- `sync_status`
- `raw_summary`
- `created_at`
- `updated_at`

Source of data: eBay Commerce Message API `getConversations`.

Write path: eBay message sync function.

Read path: Conversation inbox list.

Relationship: complements `email_messages`; should not replace non-eBay email.

Migration complexity: required for eBay-primary/hybrid conversation inbox.

### `ebay_conversation_messages`

Purpose: canonical message timeline for normal eBay conversations.

Key columns:

- `id`
- `ebay_conversation_id`
- `ebay_message_id`
- `conversation_id` FK
- `sender_username`
- `recipient_username`
- `direction` (`inbound`, `outbound`, `platform`, `unknown`)
- `subject`
- `message_body`
- `read_status`
- `sent_at`
- `received_at`
- `has_media`
- `raw_message`
- `dedupe_hash`
- `created_at`
- `updated_at`

Source of data: eBay Commerce Message API `getConversation`.

Write path: eBay message sync function.

Read path: Conversation detail timeline and classifier input.

Relationship: complements `email_message_bodies`; becomes canonical for eBay chat body text.

Migration complexity: required.

### `ebay_message_attachments`

Purpose: media metadata for eBay message media.

Key columns:

- `id`
- `conversation_message_id`
- `media_name`
- `media_type`
- `media_url`
- `storage_bucket`
- `storage_path`
- `download_status`
- `sha256`
- `metadata`

Source of data: Message API `messageMedia`; optional storage if downloaded.

Write path: message sync and optional media fetch.

Read path: conversation detail.

Migration complexity: optional for first beta unless attachments are critical.

### `ebay_message_links`

Purpose: provider-native message/conversation links to orders, order lines, listings, returns, inventory, sales, and Outlook notifications.

Key columns:

- `id`
- `conversation_id`
- `conversation_message_id`
- `link_type`
- `ebay_order_id`
- `ebay_order_line_id`
- `ebay_return_case_id`
- `email_message_id`
- `item_id`
- `sale_id`
- `matched_value`
- `match_method`
- `confidence`
- `status`
- `metadata`

Source of data: deterministic matcher evolved to accept eBay-native message bodies and references.

Write path: eBay message processing job and manual review.

Read path: context cards and draft validation.

Relationship: complements or eventually generalizes `email_message_links`.

Migration complexity: required if normal eBay conversations become first-class.

### `ebay_message_sync_runs`

Purpose: audit and checkpoint table for eBay Message API sync.

Key columns:

- `id`
- `run_type`
- `status`
- `conversation_type`
- `started_at`
- `completed_at`
- `started_by`
- `pages_fetched`
- `conversations_seen`
- `messages_seen`
- `messages_inserted`
- `messages_updated`
- `last_error_code`
- `metadata`

Source of data: sync function.

Write path: eBay message sync.

Read path: operational dashboard.

Relationship: mirrors `email_sync_runs` and `ebay_return_sync_runs`.

Migration complexity: required.

### `ebay_message_reply_drafts`

Purpose: optional provider-specific draft table if `email_response_drafts` cannot be generalized cleanly.

Preferred path: evolve toward provider-neutral drafts instead of duplicating too much.

Possible alternative:

- keep `email_response_drafts` for Outlook/email messages,
- create a provider-neutral `communication_response_drafts`,
- or create `ebay_message_reply_drafts` only for eBay conversations.

Migration complexity: optional initially; avoid until classification/draft scope is settled.

### `ebay_message_send_attempts`

Purpose: immutable audit for direct eBay API sends, Outlook relay sends, and deep-link actions.

Key columns:

- `id`
- `conversation_id`
- `conversation_message_id`
- `return_case_id`
- `draft_id`
- `provider`
- `transport` (`ebay_message_api`, `ebay_post_order`, `outlook_relay`, `ebay_deep_link`)
- `idempotency_key`
- `request_payload_hash`
- `body_hash`
- `status`
- `provider_response_id`
- `provider_message_id`
- `error_code`
- `error_message`
- `approved_by`
- `approved_at`
- `sent_by`
- `sent_at`
- `confirmed_at`
- `metadata`

Source of data: send workflow.

Write path: send function only after human approval.

Read path: timeline audit, compliance review, duplicate-send prevention.

Migration complexity: required before any app-based sending.

### `ebay_message_open_actions`

Purpose: audit when an operator opens an eBay or Outlook link instead of sending in-app.

Key columns:

- `id`
- `conversation_id`
- `return_case_id`
- `email_message_id`
- `url_type`
- `url_hash`
- `opened_by`
- `opened_at`
- `metadata`

Source of data: UI action.

Write path: operator click handler.

Read path: audit trail.

Migration complexity: optional but useful for deep-link beta fallback.

## Classification/AI Impact

Current classification is message-level and Outlook-email centered. That should evolve.

Recommended target:

- Classify eBay-native messages for message-level category and evidence.
- Maintain conversation-level rollups for operator inbox triage.
- Conversation-level urgency should be derived from the latest inbound message, unresolved high-risk message, open return/order state, and stale context warnings.
- `needs_reply` should be conversation-level, not email-level.
- Existing categories, priority, urgency, review state, safety flags, input hashes, prompt hashes, and stale context patterns should be reused.
- Add provider/source fields if classification tables are generalized.
- Avoid reclassifying both the Outlook notification and the eBay-native message as separate live work items. Use Outlook notification classifications as fallback or evidence once a canonical eBay message match exists.

Possible schema direction:

- Short term: keep `email_message_classifications` for Outlook messages and add eBay-specific classification tables for `ebay_conversation_messages` and `ebay_conversations`.
- Better medium term: create provider-neutral classification scope fields such as `subject_type`, `subject_id`, `provider`, and `source_record_id`.
- Do not force this through existing `email_message_classifications` without a careful migration plan because current FKs point to `email_messages`.

Deterministic matcher reuse:

- The extraction logic for order numbers, item IDs, transaction IDs, return IDs, tracking numbers, buyer usernames, buyer emails, SKUs, titles, and buyer history freshness remains valuable.
- It should be refactored later to accept a provider-neutral message context instead of only `email_messages`.
- eBay Message API listing references should become high-confidence message links.

Duplicate avoidance:

- If an Outlook notification maps to an eBay `conversationId` and latest eBay `messageId`, mark the Outlook message as notification evidence.
- Do not surface it as a separate "needs reply" item unless no eBay-native conversation exists.
- Store source hashes and provider ids to avoid treating quoted notification text as new buyer messages.

## Migration Impact

No migrations were modified.

Future migrations:

- Required immediately? No, not before the eBay Message API read-only proof.
- Required if pivoting to hybrid/eBay conversation source? Yes: at minimum `ebay_conversations`, `ebay_conversation_messages`, sync runs, links, and send attempts.
- Optional: attachments, open actions, provider-neutral classification/draft tables.
- Risky: changing existing `email_message_classifications` FKs or trying to make `email_messages` store eBay-native messages without a clean provider contract.

Repo-specific caution:

- A Supabase migration mismatch does not automatically mean the database is missing functionality.
- Do not run `db push --include-all` casually.
- Do not repair or reorder existing migrations as part of this architecture pivot.
- Future migrations should be small, additive, and coordinated with the team because this repo has recurring migration drift from parallel branches.

## Reusable Work

Reusable Work From Outlook Pipeline:

- Microsoft Graph OAuth connection and mailbox status.
- Outlook ingestion and durable sync architecture.
- Mailbox import/prepare lessons and bounded batch controls.
- Provider-neutral-ish email persistence tables.
- Body normalization and processing jobs.
- Deterministic matching ideas and much of the matcher extraction logic.
- `email_message_links` confidence/status/manual review pattern.
- AI classification schema, prompts, validation, input hashes, and stale warnings.
- Draft generation, draft review, approval/rejection states, and safety validators.
- Category navigation, pagination, sorting, dashboard, operational events, and event drawer patterns.
- Buyer/order/return context cards and `matched_context`.
- Buyer insights, order history, return context, and account archive coverage.
- Human-in-the-loop operational philosophy: no automatic sending, no blind mutations.
- Source-of-truth audit docs and implementation sequencing discipline.

## Work That May Need Replacement Or Reframing

Work that becomes less central under hybrid:

- Individual Outlook email rows as the primary eBay operator inbox.
- Outlook notification body rendering as the main conversation view.
- Outlook `conversation_id` as the primary eBay thread identity.
- Outlook HTML/text parsing as the source of clean buyer/seller chat messages.
- Email-only classification as the only live triage unit.
- Email-only draft/send assumptions.
- Any future 5F.6 panel that tries to make the eBay Message Log from Outlook blobs alone.

Work to pause:

- Heavy UI polish on Outlook notification blob rendering.
- Deep Outlook-only conversation parsing.
- Safe Outlook sending implementation as the primary eBay send path.

Work to redefine:

- 5F.6 should become "normalized conversation panel design/proof" rather than "eBay Message Log Panel from Outlook body".
- Phase B Safe Sending should become a provider-aware send architecture with eBay API, Outlook relay, and deep-link fallback lanes.

## Risks / Unknowns

- Commerce Message API production scope may not be enabled for the current eBay keyset/refresh token. The docs require checking available scopes on the Application Keys page.
- Existing `EBAY_OAUTH_SCOPES` default does not include `commerce.message`; reconnect/token handling will need a scoped plan.
- The current eBay OAuth callback page prints tokens to the browser for manual secret storage. That may be acceptable for existing internal setup but should be revisited before expanding message scopes.
- eBay Message API may not cover every message type the seller UI shows, especially disputes, returns, cases, or platform notices.
- Return messaging uses Post-Order APIs and is separate from Commerce Message API conversations.
- Post-Order return APIs are not sandbox-supported, so testing has to be careful in production.
- Outlook relay replies worked once but need validation across message types and time windows.
- eBay notification email templates can change at any time.
- Buyer username alone is not a safe conversation grouping key.
- Multiple conversations can share a listing, buyer, or order context.
- Direct sends are irreversible and need idempotency, audit, and no automatic retry.
- Attachments/media need policy and storage decisions.
- Classification cost and latency may increase if conversation-level rollups classify many messages.
- Migration drift remains a coordination risk.

## Recommended Next Executable Steps

1. Pause 5F.6 as an Outlook-body eBay Message Log panel.
2. Create a Step 5F.6B read-only eBay Message API capability probe:
   - verify current eBay OAuth keyset can request `commerce.message`,
   - fetch `FROM_MEMBERS` conversations,
   - fetch one known conversation from the manual relay test,
   - compare eBay `conversationId`, latest message, unread count, sender/recipient usernames, listing reference, and timestamps against the imported Outlook notification.
3. Do not send anything in the probe.
4. Do not create migrations until the probe confirms real data availability.
5. Draft the normalized conversation data contract from actual API payloads.
6. Then add additive migrations for `ebay_conversations`, `ebay_conversation_messages`, sync runs, links, and send attempts.
7. Build a read-only Conversation View before any send/reply workflow.
8. Redesign Phase B Safe Sending with three lanes:
   - eBay Message API send for normal conversations,
   - Post-Order `send_message` for returns,
   - Outlook relay reply/deep-link fallback when eBay send is unavailable.

## Final Recommendation

Use a **hybrid architecture**.

Outlook should remain in the product, but not as the canonical source for eBay conversations. It should provide notification evidence, non-eBay mailbox triage, import backup, relay fallback, and operator audit links.

eBay-native data should become canonical for eBay conversations where accessible. The eBay Commerce Message API is the right target for normal buyer/member conversations. The Post-Order Return API is the right target for return-case messages.

Supabase should hold a normalized conversation layer that unifies eBay-native conversations, return message logs, Outlook notification evidence, deterministic order/buyer/return links, AI classification, draft review, safe send attempts, and audit trail.

An eBay-like conversation inbox cannot be built correctly from Outlook data alone. It can be approximated from Outlook for beta, but that path is fragile and should be treated as a fallback, not the architecture.

Lowest-risk beta path: first prove eBay Message API read access and correlate it to the manual Outlook relay test. Then build a read-only normalized conversation inbox. Only after that should safe sending be redesigned and implemented.
