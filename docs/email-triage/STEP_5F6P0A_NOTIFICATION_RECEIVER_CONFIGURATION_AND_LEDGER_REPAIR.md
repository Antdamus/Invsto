# Step 5F.6P.0A - eBay Notification Receiver Configuration and Ledger Repair

Date: 2026-06-08

Scope: repair the deployed `ebay-message-notification` challenge path and notification ingress ledger without changing mailbox, classification, or sending architecture.

## Executive Summary

Result: **Pass for receiver configuration and ledger repair. Pass for existing mailbox regression. Live eBay-signed `NEW_MESSAGE` validation remains the next step.**

Fixed:

- eBay challenge verification now returns `200` with a 64-character SHA-256 `challengeResponse`.
- Unsigned notifications still return `412`, but now persist a `signature_failed` row in `ebay_message_notifications`.
- Duplicate `notificationId` delivery is idempotent and updates the existing ledger row.
- Local signature validation test proves a generated valid ECDSA/SHA-1 signature is accepted and a tampered payload is rejected.
- Existing Sync Recent, Refresh Timeline, dashboard, mailbox counts, and read/unread display remain green.
- Guarded provider read-state sync still works and sent no messages.

Not complete in this step:

- No live eBay-signed `NEW_MESSAGE` has been received yet because the eBay destination/subscription is not activated.
- Therefore no production row with `signature_verified = true` exists from eBay yet.

Beta readiness: **91%**.

## Root Cause

### Challenge Verification

The deployed receiver failed challenge verification with:

```text
500 missing_endpoint_verification_config
```

Evidence:

- The old function required both `EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN` and `EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL` before it would compute the challenge response.
- `supabase secrets list --project-ref byhytmarmigalvawkedi` showed the account-deletion webhook secrets existed, but the message-notification secrets were absent:

```text
EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN absent
EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL absent
EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE absent
```

The missing required value is the eBay destination verification token:

```text
EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN
```

Classification:

- Supabase secret: **Yes**. Supabase Edge Function secrets are exposed to the function as `Deno.env`.
- Edge Function env: **Yes**. This is how the function reads the value.
- eBay Notification API destination configuration: **Yes**. The same value must be configured as `deliveryConfig.verificationToken`.
- Webhook verification token: **Yes**. This is exactly the eBay endpoint verification token.

The endpoint URL is also part of eBay's challenge formula. It is configured in eBay as `deliveryConfig.endpoint`; the receiver now derives it from the incoming request if `EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL` is absent, but the production secret was set anyway to keep the hash input explicit.

Official reference: eBay requires hashing `challengeCode + verificationToken + endpoint`, returning JSON with `challengeResponse`, and using a 32 to 80 character token. See [eBay Notification API overview](https://developer.ebay.com/api-docs/commerce/notification/static/overview.html) and [createDestination](https://developer.ebay.com/api-docs/commerce/notification/resources/destination/methods/createDestination).

### Notification Ledger

The deployed receiver returned the correct unsigned-notification safety response:

```text
412 signature_verification_failed
detail = missing_x_ebay_signature
```

But no row appeared in:

```text
public.ebay_message_notifications
```

Root cause:

- The migration created a partial unique index:

```sql
create unique index if not exists ebay_message_notifications_notification_id_uidx
  on public.ebay_message_notifications(notification_id)
  where notification_id is not null;
```

- The old receiver used:

```text
upsert(..., { onConflict: "notification_id" })
```

PostgREST cannot use a plain `ON CONFLICT (notification_id)` target against that partial unique index.

Ledger failure classification:

- Policy problem: **No**. `service_role` has `select`, `insert`, and `update`, and the receiver uses the service role key.
- Trigger problem: **No evidence of a trigger failure**. The table has no required trigger path for insertion.
- Transaction rollback: **No**. The receiver does not wrap ledger insert and activity event in one SQL transaction; the activity event was recorded while the ledger row was absent.
- Validation path issue: **Yes**. The validation path attempted to ledger before returning `412`, but the insert implementation used the wrong conflict strategy.
- Signature path issue: **No for the rejection itself**. Unsigned notification rejection was correct; only persistence before rejection was broken.

## What Changed

### Edge Function

Updated:

```text
supabase/functions/ebay-message-notification/index.ts
```

Changes:

- Added request-derived endpoint fallback for challenge hashing:

```text
configured endpoint secret -> use exactly
otherwise -> use request origin + pathname
```

- Replaced partial-index-hostile upsert with:

```text
insert(row)
if duplicate notification_id / 23505 -> update existing row by notification_id
```

This preserves idempotency for eBay retries without requiring a DB migration.

### Tests and Probe

Added:

```text
tests/email-triage/ebay-message-notification.test.mjs
tests/email-triage/ebay-message-notification-live-probe.mjs
```

Updated:

```text
package.json
```

New commands:

```sh
npm run test:ebay-notification
npm run test:ebay-notification:live
```

## Validation Evidence

### Pre-Fix Live Probe

Command:

```sh
node --input-type=module <sanitized receiver probe>
```

Evidence:

```json
{
  "challenge": {
    "status": 500,
    "error": "missing_endpoint_verification_config",
    "hasChallengeResponse": false
  },
  "post": {
    "status": 412,
    "error": "signature_verification_failed",
    "detail": "missing_x_ebay_signature"
  },
  "ledger": {
    "beforeCount": 0,
    "afterCount": 0
  }
}
```

### Deployed Secrets

Command:

```sh
node_modules/supabase/bin/supabase secrets list --project-ref byhytmarmigalvawkedi | rg "EBAY_MESSAGE_NOTIFICATION|NAME"
```

After repair:

```text
EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL
EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE
EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN
```

The token value is intentionally not printed or committed. A generated token was set during this step. If eBay destination setup is done manually, rotate it to a known secure value and use the same value in eBay.

### Edge Function Deploy

Command:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-message-notification \
  --no-verify-jwt \
  --project-ref byhytmarmigalvawkedi
```

Result:

```text
Deployed Functions on project byhytmarmigalvawkedi: ebay-message-notification
```

### Challenge and Ledger Live Probe

Command:

```sh
npm run test:ebay-notification:live
```

Result:

```json
{
  "challenge": {
    "status": 200,
    "challengeResponseLength": 64
  },
  "unsignedNotification": {
    "firstStatus": 412,
    "secondStatus": 412,
    "firstError": "signature_verification_failed",
    "secondError": "signature_verification_failed"
  },
  "ledger": {
    "beforeCount": 0,
    "afterCount": 1,
    "row": {
      "id": "5822b83d-d0e7-44d8-8071-df684cf462aa",
      "publish_attempt_count": 2,
      "processing_status": "signature_failed",
      "signature_verified": false,
      "signature_verification_error": "missing_x_ebay_signature"
    }
  },
  "safety": {
    "eBayMutationPerformed": false,
    "sendsEnabled": false,
    "messagesSent": 0
  }
}
```

This confirms:

- Challenge path works.
- Invalid/unsigned signature is rejected.
- Rejected notification is persisted.
- Duplicate notification ID updates the same row.
- No send path or eBay mutation path is reached by the unsigned probe.

### Signature Validation

Command:

```sh
npm run test:ebay-notification
```

Result:

```text
4 passed
```

Coverage:

- Challenge hash order: `challengeCode + verificationToken + endpoint`.
- Endpoint override behavior.
- Generated valid ECDSA P-256 / SHA-1 signature verifies.
- Tampered payload rejects with `signature_verification_failed`.
- Receiver source no longer contains `.upsert(` or `onConflict: "notification_id"`.

Live caveat:

```text
valid eBay signature -> accepted
```

is proven at the cryptographic validation layer with a generated key pair, but not yet with an actual eBay `X-EBAY-SIGNATURE`. A live eBay-signed positive test requires the `NEW_MESSAGE` destination/subscription setup in 5F.6P.1.

### Playwright - Sync Recent and Refresh Timeline

Command:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

Report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-08T02-36-39-972Z.md
```

Result:

```text
2 passed
Blocked send attempts: 0
```

Sync Recent:

```text
runId = d256c8e2-2d2c-4a67-ac9e-cded96d540a4
status = succeeded
pagesFetched = 2
conversationsSeen = 104
conversationsInserted = 3
conversationsUpdated = 2
messagesSeen = 559
messagesInserted = 7
messagesUpdated = 3
canonicalDetailSweepCandidates = 100
canonicalDetailSweepRefreshed = 100
errors = 0
warningsCount = 0
```

Safety:

```text
readOnly = true
ebayMutationsPerformed = false
sendsEnabled = false
messagesSent = 0
```

Refresh Timeline:

```text
runId = 3741f522-e440-4a09-813d-619fee7b6f0f
status = succeeded
conversationId = 124948878211
conversationsSeen = 1
messagesSeen = 14
errors = 0
warningsCount = 0
```

Safety:

```text
readOnly = true
ebayMutationsPerformed = false
sendsEnabled = false
messagesSent = 0
```

Dashboard and mailbox:

```text
canonical_total = 438 before sync
canonicalTotalConversations = 441 after sync
dashboard refreshed successfully
mailboxRpcVersion = v2_provider_read_state
mailboxConversationsWithProviderState = 100
failedProviderUpdate = 0
unknownProviderState = 0
```

### Playwright - Guarded Provider Read Sync

Command:

```sh
EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true \
EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE \
EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE=read \
npm run test:email-triage
```

Report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-08T02-38-00-102Z.md
```

Result:

```text
2 passed
Blocked send attempts: 0
```

Provider read sync:

```text
event_type = read_state_synced
event_id = 869a905d-0dbf-44d4-b2a3-a0b359a45b8c
conversationId = 57d7978e-c1cd-40d8-bf4a-c649d36983a4
ebayConversationId = 208003637879
conversationType = FROM_EBAY
requestedReadState = read
providerResponse.status = 204
providerReadState = read
localReadState = read
pendingProviderUpdate = false
readSyncStatus = synced
```

Safety:

```text
ebayMutationsPerformed = true
sendsEnabled = false
messagesSent = 0
```

The only eBay mutation in this step was this explicit, confirmed read-state validation. No sends occurred.

## Deployment Requirements

Migration required?

```text
No.
```

Reason: the repair avoids the partial-index upsert path in code. No table, policy, trigger, or index change is required.

Edge Function deploy required?

```text
Yes. Completed for ebay-message-notification.
```

Command:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-message-notification \
  --no-verify-jwt \
  --project-ref byhytmarmigalvawkedi
```

Frontend deploy required?

```text
No.
```

New secrets required?

```text
Yes. Completed in production for the receiver.
```

Required/active secrets:

```text
EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN
EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL
EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE=true
```

Rotation command for eBay destination setup:

```sh
TOKEN="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=')"

node_modules/supabase/bin/supabase secrets set \
  EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN="$TOKEN" \
  EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification' \
  EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE='true' \
  --project-ref byhytmarmigalvawkedi
```

Use the same `$TOKEN` value as the eBay destination `deliveryConfig.verificationToken`. Do not commit it.

eBay developer-console or Notification API configuration required?

```text
Yes.
```

The repo now contains the receiver, ledger, validation tests, live probe, and deployed Edge Function. eBay-side destination and subscription activation are still required before real `NEW_MESSAGE` events arrive.

## eBay Configuration Steps for 5F.6P.1

Official references:

- [Notification API overview](https://developer.ebay.com/api-docs/commerce/notification/static/overview.html)
- [createDestination](https://developer.ebay.com/api-docs/commerce/notification/resources/destination/methods/createDestination)
- [createSubscription](https://developer.ebay.com/api-docs/commerce/notification/resources/subscription/methods/createSubscription)
- [getTopic](https://developer.ebay.com/api-docs/commerce/notification/resources/topic/methods/getTopic)
- [NEW_MESSAGE event schema](https://developer.ebay.com/develop/api/sell/notification_events#sell-notification_events-communication-NEW_MESSAGE)
- [getPublicKey](https://developer.ebay.com/api-docs/sell/notification/resources/public_key/methods/getPublicKey)

### 1. Alert Configuration

Create or verify app alert configuration:

```http
PUT https://api.ebay.com/commerce/notification/v1/config
Authorization: Bearer <client_credentials_token_with_api_scope>
Content-Type: application/json

{
  "alertEmail": "<ops-alert-email>"
}
```

Scope:

```text
https://api.ebay.com/oauth/api_scope
```

### 2. Destination Creation

Use the public Supabase Edge Function endpoint:

```text
https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification
```

Create destination:

```http
POST https://api.ebay.com/commerce/notification/v1/destination
Authorization: Bearer <client_credentials_token_with_api_scope>
Content-Type: application/json

{
  "name": "og-ebay-message-notification",
  "status": "ENABLED",
  "deliveryConfig": {
    "endpoint": "https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification",
    "verificationToken": "<same value as EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN>"
  }
}
```

During this call, eBay sends:

```text
GET /ebay-message-notification?challenge_code=<unique>
```

Expected receiver result:

```text
200
challengeResponse = 64 character SHA-256 hex digest
```

Capture the created `destinationId` from eBay's response headers/resource location or by listing destinations.

### 3. Topic Selection

Confirm topic metadata:

```http
GET https://api.ebay.com/commerce/notification/v1/topic/NEW_MESSAGE
Authorization: Bearer <client_credentials_token_with_api_scope>
```

Use:

```text
topicId = NEW_MESSAGE
payload.deliveryProtocol = HTTPS
payload.format = JSON
payload.schemaVersion = <supportedPayloads schemaVersion returned by getTopic>
```

The NEW_MESSAGE event includes `conversationId`, `conversationType`, `messageId`, and `readStatus`, which the receiver already extracts.

### 4. Subscription Creation

Create the subscription disabled first:

```http
POST https://api.ebay.com/commerce/notification/v1/subscription
Authorization: Bearer <user_or_allowed_token_for_user_subscription>
Content-Type: application/json

{
  "topicId": "NEW_MESSAGE",
  "status": "DISABLED",
  "destinationId": "<destinationId>",
  "payload": {
    "format": "JSON",
    "schemaVersion": "<schemaVersion from getTopic>",
    "deliveryProtocol": "HTTPS"
  }
}
```

Then test the disabled subscription if available:

```http
POST https://api.ebay.com/commerce/notification/v1/subscription/<subscriptionId>/test
Authorization: Bearer <same subscription-management token>
```

Expected OG validation:

```text
ebay_message_notifications row inserted
signature_verified = true
processing_status = sync_requested or sync_succeeded
provider_notification_received activity event recorded
safety.messagesSent = 0
```

After a signed test passes, enable:

```http
POST https://api.ebay.com/commerce/notification/v1/subscription/<subscriptionId>/enable
Authorization: Bearer <same subscription-management token>
```

### 5. Required Scopes

Client credentials / app-level Notification API operations:

```text
https://api.ebay.com/oauth/api_scope
```

User-based notification subscription management:

```text
https://api.ebay.com/oauth/api_scope/commerce.notification.subscription
```

NEW_MESSAGE topic authorization:

```text
https://api.ebay.com/oauth/api_scope/commerce.message
```

The existing message sync path already depends on `commerce.message`. Before 5F.6P.1, confirm the seller authorization/refresh token includes both `commerce.message` and, if eBay treats this as a user-based subscription for the seller, `commerce.notification.subscription`.

## Beta Readiness

Previous readiness:

```text
88%
```

Updated readiness:

```text
91%
```

Why not higher:

- Real eBay `NEW_MESSAGE` destination/subscription activation is still pending.
- No live eBay-signed positive notification has been received yet.
- The notification-to-targeted-refresh path is implemented, but the final proof requires eBay to deliver a signed `NEW_MESSAGE`.

## Exact Next Step

Move to:

```text
5F.6P.1 - eBay NEW_MESSAGE Subscription Activation and Live Notification Validation
```

Do not move to 5F.6M until 5F.6P.1 proves:

```text
real signed NEW_MESSAGE received
signature_verified = true
ledger row persisted
targeted sync requested and succeeds
no sends occur
no unintended eBay mutations occur
```
