# Step 5F.6P.1A - NEW_MESSAGE Activation Validation

Date: 2026-06-08

Scope: run the deployed `ebay-notification-admin` post-deploy audit, activate eBay `NEW_MESSAGE`, and validate whether a real eBay notification can update OG automatically.

## Executive Summary

Result: **Partial pass.**

Passed:

- Production Supabase/eBay secrets are sufficient for Notification API activation.
- The seller refresh token can mint a token with:
  - `https://api.ebay.com/oauth/api_scope/commerce.notification.subscription`
  - `https://api.ebay.com/oauth/api_scope/commerce.message`
- The notification receiver challenge endpoint passes.
- eBay destination was created and enabled.
- eBay `NEW_MESSAGE` subscription was created, tested, and enabled.
- eBay delivered a real signed `NEW_MESSAGE` notification to OG.

Failed:

- The deployed receiver did not verify the eBay signature.
- Ledger row status is `signature_failed`.
- `sync_run_id` is null.
- No targeted conversation refresh ran.
- Mailbox/dashboard did not update from webhook-driven sync.

Final status:

```text
NEW_MESSAGE delivery is active, but webhook-driven sync is not yet passing.
```

The blocker is not secrets, scopes, destination, subscription, or eBay developer-console configuration. The blocker is deployed receiver compatibility with eBay's provider-required ECDSA/SHA1 notification signature verification. The deployed Edge Function returned:

```text
signature_verification_error = Not implemented
```

Repo fix implemented in this step:

```text
supabase/functions/ebay-message-notification/index.ts
```

The fix adds a narrow P-256/SHA1 signature verification fallback for eBay notifications when Deno/WebCrypto cannot run native `ECDSA` + `SHA-1` verification.

## Secrets and Scope Audit

Audit command path:

```text
POST https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-notification-admin
body = {"mode":"audit"}
auth = admin browser session JWT
```

Audit result:

```json
{
  "httpStatus": 200,
  "ok": true,
  "environment": "production",
  "endpoint": "https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification",
  "topicId": "NEW_MESSAGE",
  "appTokenOk": true,
  "userSubscriptionTokenOk": true,
  "challengeOk": true,
  "challengeStatus": 200,
  "topicEnabled": true,
  "destinationConfigured": false,
  "destinationEnabled": false,
  "subscriptionConfigured": false,
  "subscriptionEnabled": false,
  "canSubscribeToday": true,
  "liveDeliveryActive": false,
  "blockers": [
    "Destination is not configured.",
    "Subscription is not configured."
  ]
}
```

Production availability:

```text
EBAY_CLIENT_ID / EBAY_APP_ID: present, inferred by successful app token mint
EBAY_CLIENT_SECRET / EBAY_CERT_ID: present, inferred by successful app token mint
EBAY_REFRESH_TOKEN: present, inferred by successful seller subscription token mint
EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN: present, inferred by challenge success
EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL: present/effective, endpoint matched deployed receiver URL
EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE: true/effective, inferred by signed notification rejection path
commerce.notification.subscription scope: present
commerce.message scope: present
```

Missing production secrets/scopes:

```text
None found by deployed audit.
```

Local tooling gap:

```text
SUPABASE_ACCESS_TOKEN is still not available locally.
```

This prevents Codex from deploying the receiver fix from this machine:

```text
node_modules/supabase/bin/supabase functions deploy ebay-message-notification --no-verify-jwt --project-ref byhytmarmigalvawkedi
-> Access token not provided.
```

## Activation Evidence

Activation request:

```json
{
  "mode": "activate",
  "apply": true,
  "confirm": "I_UNDERSTAND_THIS_CONFIGURES_EBAY_NOTIFICATIONS",
  "enable": true
}
```

Activation result:

```json
{
  "httpStatus": 200,
  "ok": true,
  "environment": "production",
  "actionStatuses": {
    "config": {
      "skipped": true,
      "reason": "No alert email configured."
    },
    "destination": {
      "created": true,
      "status": 201,
      "destinationId": "present"
    },
    "subscription": {
      "created": true,
      "status": 201,
      "subscriptionId": "present",
      "schemaVersion": "1.0"
    },
    "test": {
      "status": 202
    },
    "enable": {
      "status": 204
    }
  },
  "capability": {
    "canSubscribeToday": true,
    "liveDeliveryActive": true,
    "topicEnabled": true,
    "destinationConfigured": true,
    "destinationEnabled": true,
    "subscriptionConfigured": true,
    "subscriptionEnabled": true,
    "blockers": []
  },
  "safety": {
    "ebayNotificationConfigurationMutated": true,
    "ebayMessageMutationPerformed": false,
    "sendsEnabled": false,
    "messagesSent": 0
  }
}
```

Configured destination:

```text
status = ENABLED
endpoint = https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification
```

Configured subscription:

```text
topicId = NEW_MESSAGE
status = ENABLED
payload.format = JSON
payload.schemaVersion = 1.0
payload.deliveryProtocol = HTTPS
```

## Live Notification Evidence

After activation/test, eBay delivered a real signed notification:

```json
{
  "received_at": "2026-06-08T03:42:22.200376+00:00",
  "topic": "NEW_MESSAGE",
  "signature_verified": false,
  "signature_verification_error": "Not implemented",
  "processing_status": "signature_failed",
  "headerNames": [
    "user-agent",
    "content-type",
    "x-ebay-signature"
  ],
  "signatureHeaderPresent": true,
  "payload": {
    "metadata": {
      "topic": "NEW_MESSAGE",
      "deprecated": false,
      "schemaVersion": "1.0"
    },
    "notification": {
      "notificationId": "present",
      "eventDate": "2026-06-08T03:42:21.371Z",
      "publishDate": "2026-06-08T03:42:21.485Z",
      "publishAttemptCount": 1,
      "data": {
        "conversationId": "9394020427474",
        "conversationType": "FROM_MEMBERS",
        "messageId": "5498561796019"
      }
    }
  }
}
```

Validation result:

```text
real NEW_MESSAGE received: yes
signature_verified = true: no
ledger row inserted: yes
processing_status = sync_succeeded: no
sync_run_id populated: no
targeted conversation refreshed: no
mailbox updated automatically: no
no send attempts: yes
```

Canonical absence check:

```json
{
  "conversation": {
    "status": 200,
    "count": 0
  },
  "syncRuns": {
    "status": 200,
    "rows": []
  }
}
```

Interpretation:

```text
eBay delivery is proven.
OG receiver ingress ledger is proven.
Signature verification compatibility is the remaining blocker.
Targeted refresh did not run because the receiver correctly rejects unverified notifications while EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE is enabled.
```

## Dashboard and Mailbox Evidence

Playwright report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-08T03-46-26-935Z.md
```

Result:

```text
2 passed
blocked send attempts = 0
```

Mailbox evidence:

```json
{
  "canonical_total": 483,
  "matching_total": 483,
  "loaded_count": 100,
  "uiSummary": "CANONICAL: 483\nMatching: 483\nLOADED: 100\nDisplayed: 100\nMEMBERS: 299\neBay Notifications: 184\nUNREAD: 12\nUnclassified: 0\nLABELS: 0\n105 returns · RPC v2_provider_read_state"
}
```

Dashboard evidence:

```json
{
  "event_type": "provider_notification_received",
  "status": "failed",
  "title": "eBay notification received",
  "created_at": "2026-06-08T03:42:22.68616+00:00"
}
```

Read-state evidence:

```json
{
  "mailboxRpcVersion": "v2_provider_read_state",
  "mailboxConversationsWithProviderState": 100,
  "sampledReadState": {
    "sampled": 483,
    "providerUnread": 14,
    "localUnread": 12,
    "legacyUnread": 12,
    "pendingProviderUpdate": 2,
    "failedProviderUpdate": 0,
    "unknownProviderState": 0
  }
}
```

## Implementation Follow-Up Completed Locally

Changed:

```text
supabase/functions/ebay-message-notification/index.ts
tests/email-triage/ebay-message-notification.test.mjs
```

Reason:

```text
Deno/WebCrypto in the deployed receiver returned Not implemented for native ECDSA + SHA-1 verification.
eBay's official Notification API signature contract uses ECDSA with digest SHA1 for X-EBAY-SIGNATURE validation.
```

Fix:

```text
Keep native WebCrypto verification first.
If native ECDSA/SHA1 verification is unavailable, verify the signature with a narrow local P-256/SHA1 fallback.
Use the same eBay public key bytes fetched from /commerce/notification/v1/public_key/{kid}.
Keep SHA1 isolated to eBay notification signature verification only.
```

Local verification:

```text
Local generated P-256/SHA1 signature verified = true
Tampered payload verified = false
```

Focused tests:

```text
npm run test:ebay-notification
8 passed
```

Whitespace:

```text
git diff --check
clean
```

## eBay Reconnect Required?

Answer:

```text
No.
```

The production seller refresh token successfully minted a token with both required scopes.

## Developer Console Setup Required?

Answer:

```text
No additional developer-console setup is currently indicated.
```

The app can subscribe today, and activation succeeded through the Notification API. Keep developer-console access available only if eBay later marks the destination down, removes scopes, or requires app-level notification settings review.

## Deployment Required?

Answer:

```text
Yes.
```

The receiver compatibility fix is local and must be deployed before the next eBay retry or next real buyer message can pass.

Required command:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-message-notification \
  --no-verify-jwt \
  --project-ref byhytmarmigalvawkedi
```

Current blocker to deploy from this machine:

```text
SUPABASE_ACCESS_TOKEN is missing.
```

Set it locally or run `supabase login`, then deploy. Do not paste the token into chat.

## Exact Next Action

1. Deploy the updated `ebay-message-notification` receiver.
2. Trigger another eBay subscription test from the already-enabled subscription, or wait for eBay to retry the failed notification if retries continue.
3. Require the next ledger row to show:

```text
signature_verified = true
processing_status = sync_succeeded
sync_run_id is not null
ebay_conversation_id is populated
```

4. Confirm the targeted sync run:

```text
conversationId = notification.notification.data.conversationId
conversationPageLimit = 1
messagePageLimit = 50
maxConversationPages = 1
no archive/backfill sweep
messagesSent = 0
```

5. Re-run Playwright mailbox/dashboard smoke and confirm the dashboard event is `succeeded`.

## Final Decision

Can we move to:

```text
5F.6M - Controlled Return Messaging
```

Answer:

```text
Not yet.
```

Why:

```text
The NEW_MESSAGE subscription is now active and real delivery is proven, but the deployed receiver has not yet verified an eBay signature or executed targeted refresh.
```

Once the receiver fix is deployed and the next signed notification reaches `sync_succeeded`, this step should be considered pass-ready.
