# Step 5F.6P.1 - eBay NEW_MESSAGE Subscription Activation and Live Notification Validation

Date: 2026-06-08

Scope: determine whether OG can activate eBay Commerce Notification API `NEW_MESSAGE` delivery now, implement the strongest realistic beta architecture, and validate all existing sync/read/classification/backfill workflows with Playwright.

## Executive Summary

Result: **Fail for the core success criterion. Pass for OG-side webhook architecture, activation scaffolding, and existing live workflow regression validation.**

Core success criterion:

```text
A real eBay NEW_MESSAGE event
can cause OG to update automatically
without manual Sync Recent
and without Refresh Timeline.
```

Status:

```text
Not proven.
```

Why:

- eBay officially supports `NEW_MESSAGE` as a user-scoped Commerce Notification topic.
- The existing deployed `ebay-message-notification` receiver already verifies signatures, persists the notification ledger, extracts `conversationId`, and calls targeted `ebay-message-sync`.
- However, the eBay destination/subscription could not be activated from this machine because:
  - local env has no `SUPABASE_SERVICE_ROLE_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, or `EBAY_REFRESH_TOKEN`;
  - Supabase CLI is not logged in and cannot read/deploy production secrets;
  - `supabase secrets list` and `supabase functions deploy` both failed with `Access token not provided`;
  - eBay developer-console access and current app subscription scope state were not available.

Implemented in this step:

- Added admin-only activation/audit Edge Function scaffold: `supabase/functions/ebay-notification-admin/index.ts`.
- Registered it in `supabase/config.toml` with `verify_jwt = true`.
- Updated `ebay-oauth-callback` default scopes to include:
  - `https://api.ebay.com/oauth/api_scope/commerce.message`
  - `https://api.ebay.com/oauth/api_scope/commerce.notification.subscription`
- Added notification admin guard tests.

Beta readiness: **92%**.

Final decision: **Do not move to 5F.6M yet.** The exact next action is to deploy `ebay-notification-admin`, run its `audit` and `activate` modes with production Supabase/eBay credentials, then generate or wait for a real buyer message and prove `signature_verified = true` plus `sync_succeeded`.

## Required Audit

### A. Can the current app registration subscribe to NEW_MESSAGE today?

Answer: **Not proven from this environment.**

What is known:

- eBay supports `NEW_MESSAGE`.
- The topic requires the standard OAuth scope plus `commerce.message`.
- Subscription management for user-based topics requires an authorization-code user token with `commerce.notification.subscription`.
- Current production message sync and provider read/unread tests prove the deployed eBay token can call Commerce Message API operations requiring `commerce.message`.

What is not known:

- Whether the current production refresh token was granted `commerce.notification.subscription`.
- Whether the active eBay keyset exposes that scope on the Application Keys page.
- Whether an existing destination/subscription already exists in eBay.

Blocker:

```text
node_modules/supabase/bin/supabase secrets list --project-ref byhytmarmigalvawkedi
```

returned:

```text
Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

The same blocker prevented deploying the new admin audit/activation function.

### B. Required eBay Configuration

Official references:

- [Notification API overview](https://developer.ebay.com/api-docs/commerce/notification/static/overview.html)
- [Notification API resource list](https://developer.ebay.com/develop/api/buy/notification_api)
- [NEW_MESSAGE event schema](https://developer.ebay.com/develop/api/sell/notification_events#sell-notification_events-communication-NEW_MESSAGE)
- [createDestination](https://developer.ebay.com/api-docs/commerce/notification/resources/destination/methods/createDestination)
- [createSubscription](https://developer.ebay.com/api-docs/buy/notification/resources/subscription/methods/createSubscription)
- [getTopic](https://developer.ebay.com/api-docs/sell/notification/resources/topic/methods/getTopic)

Destination:

```text
POST /commerce/notification/v1/destination
endpoint = https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification
status = ENABLED
verificationToken = same value as EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN
```

Verification:

```text
GET endpoint?challenge_code=<challenge>
response body:
{
  "challengeResponse": sha256(challengeCode + verificationToken + endpoint)
}
```

Subscription:

```text
POST /commerce/notification/v1/subscription
topicId = NEW_MESSAGE
destinationId = <created destination id>
status = DISABLED first, then test, then ENABLED
payload.deliveryProtocol = HTTPS
payload.format = JSON
payload.schemaVersion = supportedPayloads.schemaVersion from GET /topic/NEW_MESSAGE
```

Scopes:

```text
App client credentials:
https://api.ebay.com/oauth/api_scope

Seller/user subscription token:
https://api.ebay.com/oauth/api_scope/commerce.notification.subscription
https://api.ebay.com/oauth/api_scope/commerce.message

Message sync/read token:
https://api.ebay.com/oauth/api_scope/commerce.message
```

Token requirements:

- Destination/config/topic operations use client-credentials app token.
- `NEW_MESSAGE` user subscription create/get/test/enable should use an authorization-code refresh token for the seller with both notification subscription and message scopes.
- If the current `EBAY_REFRESH_TOKEN` lacks `commerce.notification.subscription`, reconnect eBay through the updated OAuth callback default scope set and replace the Supabase secret.

### C. Can we activate and validate it during this step?

Answer: **No.**

Precise reasons:

- No local Supabase service role or eBay OAuth secrets are available.
- Supabase CLI has no access token, so production secrets cannot be inspected and new Edge Functions cannot be deployed.
- eBay developer-console access is not available in this environment.

Command evidence:

```text
node_modules/supabase/bin/supabase secrets list --project-ref byhytmarmigalvawkedi
-> Access token not provided.
```

```text
node_modules/supabase/bin/supabase functions deploy ebay-notification-admin --project-ref byhytmarmigalvawkedi
-> Access token not provided.
```

## Architecture Decision

### Current Beta Architecture

Current deployed OG architecture:

```text
eBay Message API
-> Sync Recent / targeted Refresh Timeline
-> Supabase canonical mailbox
-> provider/local read-state model
-> mailbox RPC v2_provider_read_state
-> dashboard
```

Notification receiver state:

```text
eBay NEW_MESSAGE receiver exists
challenge verification works from prior 5F.6P.0A validation
signature verification exists
notification ledger exists
valid NEW_MESSAGE path calls targeted ebay-message-sync
real eBay subscription not active/proven
```

### Preferred Production Architecture

```text
Buyer sends message on eBay
-> eBay emits NEW_MESSAGE
-> Supabase ebay-message-notification receives POST
-> X-EBAY-SIGNATURE verified using eBay public key
-> ebay_message_notifications row inserted
-> conversationId and conversationType extracted
-> ebay-message-sync runs with conversationId only
-> canonical conversation/messages updated
-> dashboard/activity event recorded
-> fallback Sync Recent reconciles missed events
```

This is the right architecture for beta and production because it avoids archive scans and limits provider detail refresh to the changed conversation.

### Fallback Architecture

Until eBay subscription activation is proven:

```text
Scheduled Sync Recent
-> latest-scope provider list
-> targeted detail refresh for recent/changed conversations
-> small canonical recent detail sweep
-> no archive backfill as live-sync substitute
```

Recommended beta cadence:

```text
operator hours: every 5 minutes
off-hours: every 15 minutes
manual Sync Recent remains available
```

## Implementation

Changed:

```text
supabase/functions/ebay-notification-admin/index.ts
supabase/config.toml
supabase/functions/ebay-oauth-callback/index.ts
tests/email-triage/ebay-notification-admin.test.mjs
package.json
```

New `ebay-notification-admin` modes:

```text
audit
ensure_config
ensure_destination
ensure_subscription
test_subscription
enable_subscription
activate
```

Safety:

- JWT-protected.
- Requires admin or service role.
- `audit` is read-only.
- Mutation modes require:

```json
{
  "apply": true,
  "confirm": "I_UNDERSTAND_THIS_CONFIGURES_EBAY_NOTIFICATIONS"
}
```

- Does not call any eBay send-message endpoint.
- Records safety metadata with `messagesSent = 0`.

OAuth callback default scopes now include messaging and subscription scopes so a reconnect can mint a refresh token capable of managing `NEW_MESSAGE`.

## Validation Evidence

### Notification Payload

No real eBay-signed `NEW_MESSAGE` payload was received in this step.

Expected live payload shape from eBay documentation:

```json
{
  "metadata": {
    "topic": "NEW_MESSAGE",
    "schemaVersion": "1.0",
    "deprecated": false
  },
  "notification": {
    "notificationId": "<ebay notification id>",
    "eventDate": "<UTC timestamp>",
    "publishDate": "<UTC timestamp>",
    "publishAttemptCount": 1,
    "data": {
      "messageId": "<message id>",
      "conversationType": "FROM_MEMBERS",
      "conversationId": "<conversation id>",
      "messageBody": "<body>",
      "senderUserName": "<sender>",
      "recipientUserName": "<recipient>"
    }
  }
}
```

Prior 5F.6P.0A live synthetic evidence remains valid for receiver challenge/rejection/ledger:

```text
challenge status = 200
unsigned POST status = 412
ledger processing_status = signature_failed
signature_verified = false
signature_verification_error = missing_x_ebay_signature
duplicate notification id updates same ledger row
```

Dashboard during this step also showed prior rejected notification events:

```text
event_type = provider_notification_received
status = failed
title = eBay notification received
latest observed event id = ab1a38c8-5043-49a1-8f20-bb2ed349f029
created_at = 2026-06-08T02:41:20.593948+00:00
```

### Signature Result

Local cryptographic validation:

```text
npm run test:ebay-notification
7 passed
```

Coverage:

- Challenge hash order.
- Endpoint override behavior.
- Valid generated ECDSA P-256 / SHA-1 signature verifies.
- Tampered payload rejects.
- Ledger insert path avoids partial-index-hostile upsert.
- New admin function is JWT-protected and guarded.
- OAuth callback default scopes include message and notification subscription scopes.

Live eBay signature:

```text
Not received in this step.
```

### Conversation ID and Targeted Refresh Evidence

Manual targeted Refresh Timeline passed through Playwright:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T03-11-51-466Z.md
runId = 8bd2a626-cfff-4fb9-b369-e780f3199885
conversationId = 208003637879
conversationType = FROM_EBAY
conversationsSeen = 1
messagesSeen = 1
messagesInserted = 0
messagesUpdated = 0
messagesRechecked = 1
canonicalDetailSweepCandidates = 0
canonicalDetailSweepRefreshed = 0
safety.messagesSent = 0
safety.ebayMutationsPerformed = false
```

This proves the targeted refresh engine still works. It does not prove webhook-triggered refresh because no real signed notification arrived.

### Mailbox Evidence

Sync Recent plus mailbox/dashboard validation:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T03-11-51-466Z.md
runId = bce1340e-0e51-42f7-90e6-a0135ba98a0d
canonicalTotalConversations = 458
pagesFetched = 2
conversationsSeen = 118
conversationsInserted = 17
conversationsUpdated = 0
messagesSeen = 573
messagesInserted = 17
messagesUpdated = 1
messagesRechecked = 556
canonicalDetailSweepCandidates = 100
canonicalDetailSweepRefreshed = 100
canonicalDetailSweepFailed = 0
warningsCount = 0
safety.messagesSent = 0
```

Mailbox RPC:

```text
mailboxRpcVersion = v2_provider_read_state
mailboxConversationsWithProviderState = 100
canonical_total = 441 before sync
canonicalTotalConversations = 458 after sync
```

### Dashboard Evidence

Dashboard rendered and matched operational events in all Playwright runs.

Read-state dashboard sample:

```text
sampled = 458
providerUnread = 20
localUnread = 18
legacyUnread = 18
pendingProviderUpdate = 2
failedProviderUpdate = 0
unknownProviderState = 0
```

Dashboard labels found:

```text
provider unread
OG unread
read sync pending
read sync failed
```

### Read State Evidence

Provider read:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T03-13-10-900Z.md
conversation = 34f6a296-396d-453a-aec3-5d72d8c08e49
ebayConversationId = 208004244369
conversationType = FROM_EBAY
providerResponse.status = 204
before provider/local = unread/unread
after provider/local = read/read
pendingProviderUpdate = false
readSyncStatus = synced
messagesSent = 0
```

Provider unread:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T03-14-04-206Z.md
conversation = 34f6a296-396d-453a-aec3-5d72d8c08e49
ebayConversationId = 208004244369
conversationType = FROM_EBAY
providerResponse.status = 204
before provider/local = read/read
after provider/local = unread/unread
pendingProviderUpdate = false
readSyncStatus = synced
messagesSent = 0
```

Local read/unread display remained green through mailbox/dashboard checks.

### Existing Systems

All commands below passed with Playwright:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true npm run test:email-triage
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=read npm run test:email-triage
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=unread npm run test:email-triage
EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
```

Classify Unclassified:

```text
run_id = 60d3341e-9080-4463-8e45-add737d10b5f
status = succeeded
requested = 100
processed = 100
attempted = 32
succeeded = 32
failed = 0
skipped = 68
messagesSent = 0
```

Reclassify Recent 20:

```text
run_id = 4653c1bf-bdd6-4097-9fd8-c335b1faaf16
status = partial_success
requested = 20
processed = 20
succeeded = 18
failed = 2
skipped = 0
duration_ms = 58691
terminal event = Classification Run Partial Success
sendAttemptsCreated = 0
```

Backfill archive:

```text
runId = df66993c-cbb2-4b2a-9fe7-b7f01bb66c46
status = succeeded
pagesFetched = 2
conversationsSeen = 50
conversationsInserted = 17
messagesSeen = 87
messagesInserted = 27
checkpoint_scope = commerce_message_archive
messagesSent = 0
```

Backfill + classify new:

```text
runId = ef385cc7-caf3-4df8-a3fc-6abcd9431cf2
status = succeeded
pagesFetched = 2
conversationsSeen = 50
conversationsInserted = 8
conversationsUpdated = 8
messagesSeen = 207
messagesInserted = 43
messagesUpdated = 5
classificationProcessed = 8
classificationSucceeded = 8
classificationFailed = 0
classificationSkipped = 42
providerReadStateChanges = 8
messagesSent = 0
```

Drafting and sending:

- The regression harness blocks browser-visible `send_message` calls and `ebay-conversation-draft` send mode.
- All reports show `Blocked send attempts: 0`.
- This step did not generate/send a new draft. It validated that the safety rails did not regress during sync/classification/backfill/read-state workflows.

## Performance Analysis

Is webhook-driven sync sufficient?

```text
Yes for message arrival once subscription is active and reliable.
```

The receiver targets one conversation and avoids archive scans. It is the correct low-latency path.

Do we still need Sync Recent?

```text
Yes.
```

Keep Sync Recent as a safety net for:

- missed eBay retries;
- receiver downtime;
- signature/public-key transient failures;
- subscription pauses/marked-down destination;
- dashboard drift and read-state reconciliation.

How often should fallback polling run?

```text
Every 5 minutes during operator hours.
Every 15 minutes off-hours.
Manual Sync Recent remains available.
```

Can mailbox sweeps be reduced?

```text
Yes after live webhook delivery is proven for several days.
```

Current Sync Recent still refreshed 100 canonical detail sweep candidates. After real `NEW_MESSAGE` proves stable, reduce the recent detail sweep from 100 to 25-50, then consider disabling the sweep during operator hours while keeping fallback polling.

## Remaining Risks

- No real eBay-signed `NEW_MESSAGE` received yet.
- Current seller refresh token may not include `commerce.notification.subscription`.
- Current eBay app keyset may not expose the subscription scope.
- eBay destination may not exist or may become `MARKED_DOWN`.
- Receiver performs targeted sync synchronously during webhook handling; a slow eBay Message API call could risk eBay retry even if ledger insert succeeded.
- UI has no realtime subscription for canonical mailbox changes; a browser already open may need user refresh, existing polling, or a later realtime bridge to show webhook updates instantly.
- eBay public-key fetch depends on client-credentials token and eBay Notification API availability.
- Signature validation uses SHA-1 with ECDSA because eBay's header contract documents SHA1. This is provider-required but should stay isolated to notification verification.
- Backfill checkpoints are healthy but archive size is large (`FROM_EBAY` total around 10147, `FROM_MEMBERS` around 1812), so archive backfill must remain chunked.
- Reclassify Recent 20 returned partial success: 18 succeeded, 2 failed. This is terminalized and safe, but not zero-error.
- Local machine cannot deploy or inspect production secrets without `SUPABASE_ACCESS_TOKEN`.

## Deployment Requirements

Migration required?

```text
No.
```

Edge Function deploy required?

```text
Yes.
```

Required deploys:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-notification-admin \
  --project-ref byhytmarmigalvawkedi
```

If OAuth callback defaults should be live for reconnects:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-oauth-callback \
  --project-ref byhytmarmigalvawkedi
```

Existing receiver should already be deployed from 5F.6P.0A, but redeploy if needed:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-message-notification \
  --no-verify-jwt \
  --project-ref byhytmarmigalvawkedi
```

Frontend deploy required?

```text
No for this step.
```

New secrets required?

```text
No new secret names if existing eBay credentials and notification receiver token are present.
Possibly a new EBAY_REFRESH_TOKEN value if current token lacks commerce.notification.subscription.
```

Required/expected Supabase secrets:

```text
EBAY_CLIENT_ID or EBAY_APP_ID
EBAY_CLIENT_SECRET or EBAY_CERT_ID
EBAY_REFRESH_TOKEN
EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN
EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL
EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE=true
optional EBAY_NOTIFICATION_ALERT_EMAIL
optional EBAY_NOTIFICATION_SCOPE=https://api.ebay.com/oauth/api_scope
optional EBAY_NOTIFICATION_SUBSCRIPTION_SCOPE=https://api.ebay.com/oauth/api_scope/commerce.notification.subscription https://api.ebay.com/oauth/api_scope/commerce.message
```

eBay developer-console changes required?

```text
Yes unless the current app already has the required scopes and subscription.
```

Required:

- Ensure the Production keyset exposes `commerce.message`.
- Ensure the Production keyset exposes `commerce.notification.subscription`.
- Reconnect eBay OAuth if the current refresh token was not granted both scopes.
- Create or enable Notification API destination.
- Create/test/enable `NEW_MESSAGE` subscription.

Activation command after deploy:

```sh
curl -sS \
  -H "Authorization: Bearer <admin-or-service-role-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"audit"}' \
  https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-notification-admin
```

Activation:

```sh
curl -sS \
  -H "Authorization: Bearer <admin-or-service-role-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "activate",
    "apply": true,
    "confirm": "I_UNDERSTAND_THIS_CONFIGURES_EBAY_NOTIFICATIONS",
    "enable": true
  }' \
  https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-notification-admin
```

Then validate real event:

```text
Send or receive a real buyer message on eBay.
Query ebay_message_notifications for latest topic NEW_MESSAGE.
Require signature_verified = true.
Require processing_status = sync_succeeded.
Require sync_run_id not null.
Require targeted conversation changed or at least was rechecked.
Require dashboard/provider_notification_received succeeded event.
Require messagesSent = 0.
```

## Beta Readiness

Previous readiness:

```text
91-92%
```

Updated readiness:

```text
92%
```

Why not higher:

- Real eBay subscription activation is still not complete.
- No real eBay-signed positive notification has been received.
- Open UI still lacks realtime canonical mailbox updates from webhook changes.

## Final Decision

Can we move to:

```text
5F.6M - Controlled Return Messaging
```

Answer:

```text
No.
```

Reason:

```text
The core objective was not met: no real eBay NEW_MESSAGE event has proven automatic OG update without manual Sync Recent or Refresh Timeline.
```

Recommended next step:

```text
5F.6P.1A - Deploy ebay-notification-admin, activate NEW_MESSAGE, and capture the first real signed notification.
```

Exit criteria for 5F.6P.1A:

```text
real eBay NEW_MESSAGE arrives
signature_verified = true
ledger row created
sync_run_id populated
processing_status = sync_succeeded
conversationId targeted only
canonical mailbox updated
dashboard shows succeeded provider notification
no sends
no manual Sync Recent
no manual Refresh Timeline
```
