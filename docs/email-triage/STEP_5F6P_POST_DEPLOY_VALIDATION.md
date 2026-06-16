# Step 5F.6P Post-Deploy Validation

Date: 2026-06-08

Scope: production validation after the provider read-state migrations and Edge Function deploys for `ebay-message-sync`, `ebay-message-read-sync`, and `ebay-message-notification`.

Validated deployed migrations:

```text
20260608120000_ebay_provider_read_state_sync.sql
20260608123000_ebay_message_notifications.sql
20260608124500_ebay_canonical_mailbox_provider_read_state.sql
```

Validated deployed functions:

```text
ebay-message-sync
ebay-message-read-sync
ebay-message-notification
```

## Executive Summary

Result: **Fail for full 5F.6P post-deploy clearance; pass for mailbox sync/read-state behavior.**

The production mailbox sync path is working, including existing conversation updates, targeted timeline refresh, canonical detail sweep, provider-aware read-state display, and explicit OG-to-eBay read/unread mutations. The no-send guardrails remained intact.

The notification receiver is deployed and reachable, but it is not ready for eBay NEW_MESSAGE subscription activation yet:

- `GET /ebay-message-notification?challenge_code=...` returned `500 missing_endpoint_verification_config`.
- Unsigned `NEW_MESSAGE` POST correctly returned `412 signature_verification_failed`.
- The notification ledger table exists and is queryable, but the rejected synthetic notification was not inserted into `ebay_message_notifications`.
- A `provider_notification_received` activity event was recorded with `signature_verified = false`, `signature_error = missing_x_ebay_signature`, and no sends/mutations.

Final decision: **do not move directly to 5F.6M.** The exact next step should be:

```text
5F.6P.0A — eBay Notification Receiver Configuration and Ledger Repair
```

After that repair, proceed to:

```text
5F.6P.1 — eBay NEW_MESSAGE Subscription Activation and Live Notification Validation
```

Beta readiness: **88%**. This is up from the pre-deploy estimate because provider-aware read/unread and efficient polling/targeted refresh are working, but live notification activation is blocked.

## Commands Run

```sh
npm run test:email-triage
```

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true \
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE \
EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=read \
npm run test:email-triage
```

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true \
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE \
EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=unread \
npm run test:email-triage
```

Additional receiver probe:

```sh
node --input-type=module
```

Used to call the deployed `ebay-message-notification` challenge endpoint, submit an unsigned synthetic `NEW_MESSAGE`, and query the notification/activity tables. The script did not print credentials.

Harness note: `tests/email-triage/supabase-readonly-checks.mjs` was updated to include message read-state fields in `summarizeMessages`. This is a validation-harness-only change that allowed Refresh Timeline to distinguish read-state-only provider updates from true no-op refreshes.

## Validation Evidence

### Playwright Reports

| Report | Result | Evidence |
|---|---:|---|
| `tests/email-triage/reports/email-triage-regression-2026-06-08T01-42-48-312Z.md` | Pass | Baseline mailbox/RPC/dashboard/read-state validation. |
| `tests/email-triage/reports/email-triage-regression-2026-06-08T02-07-50-702Z.md` | Pass | Exact required Sync Recent + Refresh Timeline run. |
| `tests/email-triage/reports/email-triage-regression-2026-06-08T01-56-57-333Z.md` | Pass | Explicit provider mark-read mutation. |
| `tests/email-triage/reports/email-triage-regression-2026-06-08T02-00-02-309Z.md` | Pass | Explicit provider mark-unread mutation. |
| `tests/email-triage/reports/email-triage-regression-2026-06-08T02-05-33-926Z.md` | Pass | Refresh Timeline standalone rerun after read-state-aware harness summary. |
| `tests/email-triage/reports/email-triage-regression-2026-06-08T01-48-51-397Z.md` | Browser wait failed | Initial post-deploy Sync Recent stress run timed out in Playwright, but the backend sync run succeeded durably. |

### Sync Recent

Exact required combined run passed.

Run ID:

```text
6df90fcf-7ae9-4990-a70d-158c15454104
```

Evidence:

- Status: `succeeded`
- Pages fetched: `2`
- Conversations seen: `102`
- Conversations inserted: `1`
- Conversations updated: `2`
- Messages seen: `553`
- Messages inserted: `6`
- Messages updated: `0`
- Canonical detail sweep candidates: `100`
- Canonical detail sweep refreshed: `100`
- Provider read-state changes: `0`
- Pending read-sync conversations: `0`
- Safety: `readOnly: true`, `ebayMutationsPerformed: false`, `sendsEnabled: false`, `messagesSent: 0`

Additional stress evidence:

```text
65815ac0-2957-4281-90e3-d3f6d8325495
```

This earlier post-deploy run succeeded durably with `109` conversations seen, `7` inserted, `9` updated, `560` messages scanned, `17` inserted, `15` updated, and `100` canonical detail sweep refreshes. The activity event was:

```text
f88d9c54-fa8c-483d-b553-102b43260d3f
```

The browser wait timed out around that run. The durable backend result was good, but it is still a UX/recovery risk for larger first-post-deploy deltas.

Rafa-style/canonical detail evidence:

- Conversation `124850576707` appeared in the canonical detail sweep list during the initial stress run.
- Conversation `125786456410` was refreshed by the exact required combined run and subsequent targeted timeline refresh.

### Refresh Timeline

Exact combined-run targeted refresh passed.

Run ID:

```text
6217e559-42e9-47d6-934d-1aefc35183bf
```

Evidence:

- Conversation ID: `125786456410`
- Status: `succeeded`
- Conversations seen: `1`
- Messages seen: `3`
- Messages updated: `3`
- Safety: `readOnly: true`, `ebayMutationsPerformed: false`, `sendsEnabled: false`, `messagesSent: 0`
- Message persistence summary changed from `read:false` to `true:true`, proving read-state-aware message metadata persisted.

Standalone refresh also passed:

```text
24be8dac-60ad-4642-b33a-3a46c85c66e6
```

That run returned no inserted/updated messages, and stable persistence was expected.

### Read / Unread

Provider-aware schema is live in the canonical mailbox:

```text
mailboxRpcVersion = v2_provider_read_state
mailboxConversationsWithProviderState = 100
```

Dashboard/read-state sample from the exact combined run:

```text
sampled = 437
providerUnread = 15
localUnread = 13
legacyUnread = 13
pendingProviderUpdate = 2
failedProviderUpdate = 0
unknownProviderState = 0
```

Explicit OG -> eBay mark-read passed:

```text
Activity event: ce12cb2a-db81-45ee-a475-2177ccf3698d
Conversation: 125786456410
Provider response: 204
Before: unread_count=1, provider_read_state=unread, local_read_state=unread
After: unread_count=0, provider_read_state=read, local_read_state=read
pending_provider_update=false
read_sync_status=synced
messagesSent=0
```

Explicit OG -> eBay mark-unread passed:

```text
Activity event: 33453464-aabb-4e6a-b9a5-a1235572ee7e
Conversation: 125786456410
Provider response: 204
Before: unread_count=0, provider_read_state=read, local_read_state=read
After: unread_count=1, provider_read_state=unread, local_read_state=unread
pending_provider_update=false
read_sync_status=synced
messagesSent=0
```

Provider -> OG reconciliation was validated through provider refreshes after the explicit provider updates. Current direct query for `125786456410` after refresh:

```text
provider_read_state=unread
local_read_state=unread
pending_provider_update=false
read_sync_status=synced
last_provider_seen_at=2026-06-08T02:07:39.019+00:00
last_read_sync_at=2026-06-08T02:07:39.019+00:00
```

Remaining pending read-sync rows are visible and not failed:

```text
pending rows: 2
failed rows: 0
status: pending_provider_update
conversation_type: FROM_EBAY
```

These rows are dashboard-visible local/provider differences, not hidden failures.

### Dashboard

Dashboard rendering passed in all Playwright runs.

Validated labels:

```text
provider unread
OG unread
read sync pending
read sync failed
```

Canonical summary from the exact combined run:

```text
CANONICAL: 437
Matching: 437
LOADED: 100
Displayed: 100
MEMBERS: 278
eBay Notifications: 159
UNREAD: 13
Unclassified: 7
104 returns
RPC v2_provider_read_state
```

After Sync Recent, canonical total increased to `438`, matching the inserted production conversation.

### Notification Receiver

Function endpoint:

```text
https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification
```

Challenge probe:

```text
status = 500
error = missing_endpoint_verification_config
challengeResponse = absent
```

This means `EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN` and/or `EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL` are missing in the deployed function environment.

Unsigned synthetic `NEW_MESSAGE` probe:

```text
status = 412
error = signature_verification_failed
detail = missing_x_ebay_signature
```

This is the correct safety behavior for an unsigned notification when signature enforcement is enabled.

Notification ledger:

```text
table ebay_message_notifications query status = 200
rows after synthetic notification = 0
```

The table exists, but the receiver did not insert the rejected synthetic notification. The most likely cause is the deployed code using:

```text
upsert(..., { onConflict: "notification_id" })
```

while the migration created only a partial unique index on `notification_id`. PostgreSQL cannot infer a plain `ON CONFLICT (notification_id)` target from that partial index.

Activity event:

```text
id = 9f91bad6-61a1-4fe2-8f8f-e0f561ba9c96
event_type = provider_notification_received
status = failed
detail = 125786456410
signature_verified = false
signature_error = missing_x_ebay_signature
safety.messages_sent = 0
safety.sends_enabled = false
safety.ebay_mutation_performed = false
```

Targeted refresh path:

- The `ebay-message-sync` targeted refresh path is callable and passed through Playwright with run ID `6217e559-42e9-47d6-934d-1aefc35183bf`.
- The notification receiver's internal notification-to-targeted-refresh path was not live-validated because no valid eBay-signed `NEW_MESSAGE` notification was available and the challenge configuration is missing.

Webhook activation:

```text
Not configured/validated yet.
```

Do not claim live notification support until challenge config is present, ledger insert works, eBay subscription is activated, and a real signed NEW_MESSAGE event triggers a targeted refresh.

### Safety

Blocked send attempts:

```text
0
```

Sync/refresh safety:

```text
readOnly=true
ebayMutationsPerformed=false
sendsEnabled=false
messagesSent=0
```

Provider read/unread safety:

```text
ebayMutationsPerformed=true
sendsEnabled=false
messagesSent=0
```

The only eBay mutations observed were the two explicit read/unread tests the validation requested. No unintended sends or eBay message mutations were observed.

## Remaining Issues

1. **Notification challenge config missing.**
   The deployed `ebay-message-notification` function cannot complete eBay endpoint verification until `EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN` and `EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL` are set.

2. **Notification ledger insert is not working.**
   The table exists, but the synthetic rejected notification did not create an `ebay_message_notifications` row. Fix the `notification_id` conflict strategy before activation.

3. **Live NEW_MESSAGE webhook is not validated.**
   No eBay subscription is active yet, and no real signed eBay notification has been received.

4. **Initial large Sync Recent run exposed a browser timeout/recovery risk.**
   The backend run succeeded, but the first post-deploy stress run exceeded the Playwright/browser response wait. The exact required combined run later passed, so this is not a correctness blocker, but it should be monitored or hardened.

5. **Two pending provider read-sync rows remain.**
   They are visible in the dashboard and have no errors, but they should be drained or intentionally left as pending before a broader beta.

## Deployment Requirements

Current deployed read-state/sync validation:

```text
Migration required? No. The three listed migrations are applied.
Edge Function deploy required? No for ebay-message-sync and ebay-message-read-sync.
Frontend deploy required? No.
```

Notification stabilization before 5F.6P.1:

```text
Migration required? Yes, if fixing the ledger by adding a non-partial notification_id uniqueness target; otherwise change receiver code to avoid the partial-index upsert.
Edge Function deploy required? Yes, if receiver code is changed.
Frontend deploy required? No.
New secrets required? Yes.
eBay app configuration required? Yes.
Webhook destination required? Yes.
```

Required notification secrets:

```sh
node_modules/supabase/bin/supabase secrets set \
  EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN='<generated-verification-token>' \
  EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification' \
  --project-ref byhytmarmigalvawkedi
```

If a DB repair migration is created:

```sh
node_modules/supabase/bin/supabase db push --project-ref byhytmarmigalvawkedi
```

If receiver code is changed:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-message-notification \
  --no-verify-jwt \
  --project-ref byhytmarmigalvawkedi
```

Post-repair validation:

```sh
npm run test:email-triage
```

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

Then run a notification probe that verifies:

```text
challenge returns 200 with challengeResponse
unsigned notification returns 412 and writes a signature_failed ledger row
real signed NEW_MESSAGE writes a ledger row and triggers targeted sync
```

## Beta Readiness

Updated beta readiness:

```text
88%
```

What is ready:

- Canonical mailbox RPC still works.
- Sync Recent updates existing conversations and inserts new recent provider conversations.
- Canonical detail sweep works.
- Refresh Timeline works.
- Provider-aware read/unread display works.
- Explicit OG-to-eBay read and unread mutations work and return provider `204`.
- Provider refresh reconciles the tested conversation back into OG read-state fields.
- Dashboard counts and labels are truthful.
- No-send safety held.

What is not ready:

- eBay NEW_MESSAGE live notification activation.
- Notification challenge verification.
- Notification ledger persistence.
- Live signed notification-to-targeted-refresh validation.

## Final Decision

Do **not** move directly to:

```text
5F.6M — Controlled Return Messaging
```

Do **not** activate 5F.6P.1 until the notification receiver can pass challenge and ledger validation.

Proceed next to:

```text
5F.6P.0A — eBay Notification Receiver Configuration and Ledger Repair
```

Then move to:

```text
5F.6P.1 — eBay NEW_MESSAGE Subscription Activation and Live Notification Validation
```
