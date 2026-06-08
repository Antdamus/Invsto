# Step 5F.6P - Provider-Aware Live Sync, Read/Unread, and Notification Probe

Validation date: 2026-06-08

Scope: provider capability audit, provider/local read-state data model, targeted live-sync notification scaffold, efficient polling fallback, frontend truth labels, and Playwright harness coverage. This step does not enable automatic sends. It introduces eBay read/unread mutation only through a guarded Edge Function and explicit operator controls.

## Capability Audit

| Question | Finding | Evidence |
| --- | --- | --- |
| Can we read provider read/unread status? | Yes. Conversation lists expose unread count, conversation/detail payloads expose message read fields, and `NEW_MESSAGE` notification payloads expose `readStatus`. | eBay Message API docs for `getConversations` and `getConversation`; eBay NEW_MESSAGE notification schema includes `readStatus`. |
| Can we update provider read/unread from OG? | Yes. `updateConversation` supports a `read` boolean and returns HTTP 204 on success. | eBay `updateConversation` docs: `POST /commerce/message/v1/update_conversation` with `conversationId`, `conversationType`, and `read`. |
| Can we mark a conversation read in eBay? | Yes. Call `updateConversation` with `read: true`. | eBay sample request shows `{ "conversationId": "...", "conversationType": "FROM_MEMBERS", "read": true }`. |
| Can we mark a conversation unread in eBay? | Yes. Call `updateConversation` with `read: false`. | eBay request-field docs define `read` as a boolean where true means read and false means unread. |
| Does `updateConversation` or `bulkUpdateConversation` support required status fields? | Yes. `updateConversation` is safest for one selected conversation. `bulkUpdateConversation` also supports conversation status values including `READ` and `UNREAD`, but this step uses the single-conversation endpoint to minimize blast radius. | eBay `updateConversation` docs and `BulkConversation`/`BulkUpdateConversationsRequest` docs. |
| Are required scopes already available? | Code already uses/defaults `https://api.ebay.com/oauth/api_scope/commerce.message` for Message API calls. The deployed refresh token still must include that scope. | Existing `ebay-message-sync` flow and new `ebay-message-read-sync` use `EBAY_MESSAGE_SCOPE` with `commerce.message` default. |
| Does eBay Notification API support `NEW_MESSAGE` or equivalent? | Yes. `NEW_MESSAGE` is a supported notification topic for communication/message events. | eBay Notification API NEW_MESSAGE schema. |
| Can the notification identify the changed conversation? | Yes. The `NEW_MESSAGE` payload includes `conversationId`, `conversationType`, `messageId`, `readStatus`, and message metadata. | eBay NEW_MESSAGE notification schema. |
| Can Supabase Edge Functions receive and verify notifications? | Yes. Supabase can expose public Edge Functions; this repo already uses that pattern for `ebay-account-deletion`. This step adds a public `ebay-message-notification` receiver with challenge response, `X-EBAY-SIGNATURE` verification, and a notification ledger. | Existing `supabase/config.toml` account-deletion public function plus new notification function. |
| If webhooks are not immediately usable, what is the best fallback? | Keep scheduled/latest Sync Recent and targeted Refresh Timeline. Use provider recent lists plus detail refresh for only recent/changed conversations and preserve the canonical detail sweep. Do not backfill or scan the archive. | Existing `ebay-message-sync` incremental/latest path, now with provider read-state reconciliation counters. |

Primary eBay references:

- [Message API overview](https://developer.ebay.com/api-docs/commerce/message/overview.html)
- [updateConversation](https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/updateConversation)
- [bulkUpdateConversation](https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/bulkUpdateConversation)
- [BulkConversation type](https://developer.ebay.com/api-docs/commerce/message/types/m2m%3ABulkConversation)
- [Notification API getPublicKey](https://developer.ebay.com/api-docs/sell/notification/resources/public_key/methods/getPublicKey)
- [NEW_MESSAGE notification schema](https://developer.ebay.com/develop/api/sell/notification_events#sell-notification_events-communication-NEW_MESSAGE)
- [Notification signature validation overview](https://developer.ebay.com/api-docs/buy/notification/overview.html)

## Implemented

### Provider-Aware Data Model

Migration:

```text
supabase/migrations/20260608120000_ebay_provider_read_state_sync.sql
```

Adds explicit read-state columns:

```text
provider_read_state
local_read_state
pending_provider_update
last_provider_seen_at
last_local_read_at
last_read_sync_at
read_sync_status
read_sync_error
```

It also replaces `mark_ebay_conversation_read(uuid)` as local/provider-aware, adds `mark_ebay_conversation_unread(uuid)`, and records new activity event types:

```text
read_state_synced
read_state_sync_failed
provider_notification_received
```

Migration:

```text
supabase/migrations/20260608124500_ebay_canonical_mailbox_provider_read_state.sql
```

Replaces `get_ebay_canonical_mailbox_v2(...)` so mailbox rows include provider/local read state fields. This keeps the mailbox RPC intact while exposing the new state.

### Provider-Aware Sync Recent

Updated:

```text
supabase/functions/ebay-message-sync/index.ts
```

Sync now:

- reads provider read state from `unreadCount`, `read`, `readStatus`, or latest message read fields when present;
- updates `provider_read_state` and `last_provider_seen_at`;
- updates local read state from provider only when no OG-to-provider update is pending;
- preserves `local_read_state` and `pending_provider_update` while an OG provider update is still outstanding;
- clears pending state when eBay later reports the same state OG requested;
- refreshes message `read_status` and `is_read` when provider details include them;
- records `provider_read_state_changes` and `pending_read_sync_conversations` counters.

### Guarded Provider Read Sync

Added:

```text
supabase/functions/ebay-message-read-sync/index.ts
```

This JWT-protected/admin-gated function calls:

```text
POST /commerce/message/v1/update_conversation
```

with:

```json
{
  "conversationId": "<ebay_conversation_id>",
  "conversationType": "FROM_MEMBERS",
  "read": true
}
```

or:

```json
{
  "conversationId": "<ebay_conversation_id>",
  "conversationType": "FROM_MEMBERS",
  "read": false
}
```

Safety behavior:

- sends remain disabled;
- no `send_message` endpoint is called;
- provider mutation is only read/unread status;
- failures leave `pending_provider_update = true` and `read_sync_status = provider_update_failed`;
- successes set provider/local states to the requested state and clear pending.

### Notification Receiver Scaffold

Added:

```text
supabase/functions/ebay-message-notification/index.ts
supabase/migrations/20260608123000_ebay_message_notifications.sql
```

The receiver:

- handles eBay challenge verification;
- verifies `X-EBAY-SIGNATURE` by decoding `kid`, fetching/caching eBay public key, and verifying the raw payload;
- stores every notification in `ebay_message_notifications`;
- accepts `NEW_MESSAGE`;
- extracts `conversationId`, `conversationType`, `messageId`, and `readStatus`;
- calls existing `ebay-message-sync` with a targeted `conversationId` refresh;
- records `provider_notification_received` activity.

This is scaffolded for production once eBay app destination/subscription configuration is completed.

### Frontend Truth Labels

Updated:

```text
email-triage.api.js
email-triage.js
email-triage.state.js
email-triage.diagnostics.js
email-triage.css
```

The UI now shows:

- `eBay Read` / `eBay Unread` / unknown provider state;
- `OG Read` / `OG Unread`;
- read sync aligned, pending, or failed;
- dashboard counts for provider unread, OG unread, pending read sync, failed read sync;
- latest sync counters for provider read changes and pending read sync conversations.

The detail pane exposes explicit provider controls:

```text
Sync Read to eBay
Sync Unread to eBay
```

Opening/selecting a conversation may still mark OG local state read. It does not silently mutate eBay. If provider state differs, the row is marked pending until the explicit provider sync action succeeds or a future automated policy is enabled.

### Playwright Harness

Updated:

```text
tests/email-triage/email-triage-regression.spec.mjs
tests/email-triage/supabase-readonly-checks.mjs
```

The harness now:

- verifies provider/local read labels render;
- verifies canonical mailbox RPC rows include provider read fields;
- includes read-state fields in conversation summaries;
- blocks any unexpected browser-side `update_conversation` call;
- keeps provider read mutation opt-in with:

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE
```

## Intentionally Deferred

- Automatic eBay read/unread mutation on row selection. This avoids hidden eBay state changes during beta.
- Batch `bulkUpdateConversation`. Single-conversation `updateConversation` is safer and easier to validate.
- Creating the eBay Notification API destination/subscription from code. That requires app/account configuration and should be done deliberately after function deployment.
- A cron job to drain all `pending_provider_update` rows. The UI and dashboard now expose pending state truthfully; automatic provider mutation policy can be added after beta review.

## Polling Fallback

If webhooks are not usable today, use:

```text
scheduled Sync Recent
provider recent list
targeted detail refresh for recent/changed conversations
provider read-state reconciliation
canonical detail sweep for recent visible rows
```

Do not use archive backfill as a live-sync substitute.

Suggested cadence for beta:

```text
every 5-10 minutes during operator hours
```

The fallback remains bounded to recent conversations and targeted detail refreshes.

## Validation Evidence

Local/default Playwright validation completed before deploying the new migrations:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T01-28-38-628Z.md
Result: 2 passed
Blocked send attempts: 0
Canonical total: 430
Read-state schema validation: skipped because the Supabase project still reports mailbox RPC v2 and the provider read-state migration has not been applied yet.
```

This confirms the existing mailbox/dashboard/default workflow still renders without sends or browser-side eBay mutations before deployment. It does not validate provider read reconciliation until the migration and Edge Functions are deployed.

Local validation limitations:

```text
node_modules/supabase/bin/supabase db lint
```

could not run because local Postgres at `127.0.0.1:54322` was not running.

```text
deno check
```

could not run because `deno` is not installed in this shell.

Syntax/whitespace checks that did pass:

```sh
git diff --check
node --check email-triage.api.js
node --check email-triage.js
node --check email-triage.diagnostics.js
node --check email-triage.state.js
node --check tests/email-triage/email-triage-regression.spec.mjs
node --check tests/email-triage/supabase-readonly-checks.mjs
npm run test:email-triage
```

Commands to run after migration/function/frontend deployment:

```sh
npm run test:email-triage
```

Live Sync Recent and Refresh Timeline validation:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

Optional provider read mutation validation:

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true \
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE \
EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=read \
npm run test:email-triage
```

Optional unread validation:

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true \
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE \
EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=unread \
npm run test:email-triage
```

Expected harness evidence:

- Sync Recent still updates existing conversations with new messages.
- Refresh Timeline still performs targeted detail refresh.
- Read/unread labels render in mailbox detail and operations dashboard.
- Provider read-state changes appear in Sync Recent counters when provider state changes.
- Provider read mutation step records `ebayMutationsPerformed: true` only for `ebay-message-read-sync`.
- No sends occur.
- No browser-side direct eBay mutation occurs.

## Deployment Requirements

Migration required?

```text
Yes.
```

Commands:

```sh
node_modules/supabase/bin/supabase db push --project-ref byhytmarmigalvawkedi
```

Edge Function deploy required?

```text
Yes.
```

Commands:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-message-sync --project-ref byhytmarmigalvawkedi
node_modules/supabase/bin/supabase functions deploy ebay-message-read-sync --project-ref byhytmarmigalvawkedi
node_modules/supabase/bin/supabase functions deploy ebay-message-notification --no-verify-jwt --project-ref byhytmarmigalvawkedi
```

Frontend deploy required?

```text
Yes.
```

Files changed:

```text
email-triage.api.js
email-triage.js
email-triage.state.js
email-triage.diagnostics.js
email-triage.css
```

Use the normal static asset deployment path for OG.

New secrets required?

```text
For provider read sync: no new secret if EBAY_CLIENT_ID/EBAY_CLIENT_SECRET/EBAY_REFRESH_TOKEN already exist and the refresh token has commerce.message scope.

For notifications: yes.
```

Notification secrets:

```sh
node_modules/supabase/bin/supabase secrets set \
  EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN='<random-verification-token>' \
  EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification' \
  EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE='true' \
  --project-ref byhytmarmigalvawkedi
```

Optional notification scope override:

```sh
node_modules/supabase/bin/supabase secrets set \
  EBAY_NOTIFICATION_SCOPE='https://api.ebay.com/oauth/api_scope' \
  --project-ref byhytmarmigalvawkedi
```

eBay app configuration required?

```text
Yes, for webhook mode.
```

Required eBay configuration:

- Create/update Notification API destination.
- Set endpoint URL to:

```text
https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification
```

- Use the same verification token stored in Supabase.
- Create/enable a `NEW_MESSAGE` subscription for the seller/account.
- Ensure the user authorization token includes:

```text
https://api.ebay.com/oauth/api_scope/commerce.message
```

Webhook destination required?

```text
Yes, if event-driven live sync is enabled.
```

If destination/subscription cannot be configured today, leave webhook disabled and run the bounded polling fallback.

## Beta Readiness

Previous readiness:

```text
84%
```

Updated readiness after implementation, before deployed webhook validation:

```text
89%
```

Why not higher:

- eBay notification destination/subscription still needs app configuration.
- The provider read mutation path is implemented but should be live-validated only with explicit confirmation.
- Automatic draining of pending provider updates is intentionally deferred.

## Exact Next Step

Deploy migrations/functions/frontend, configure or deliberately defer eBay `NEW_MESSAGE` subscription, then run:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

Then run the explicit provider read mutation probe:

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true \
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE \
EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=read \
npm run test:email-triage
```

If both pass and no webhook configuration blocker appears, OG can move to:

```text
5F.6M - Controlled Return Messaging
```

If webhook setup cannot be completed before beta, proceed with the polling fallback and schedule one narrow follow-up:

```text
5F.6P.1 - eBay NEW_MESSAGE Subscription Activation and Live Notification Validation
```
