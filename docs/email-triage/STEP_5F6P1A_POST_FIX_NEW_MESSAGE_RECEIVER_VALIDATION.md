# Step 5F.6P.1A - Post-Fix NEW_MESSAGE Receiver Validation

Date: 2026-06-08

Scope: validate the deployed `ebay-message-notification` signature compatibility fix and determine whether a real eBay `NEW_MESSAGE` webhook now completes automatic targeted sync.

## Executive Summary

Result: **Fail for the full success criterion. Partial pass for post-fix receiver validation.**

What passed:

- eBay `NEW_MESSAGE` delivery remains active.
- A fresh eBay subscription-test `NEW_MESSAGE` was delivered after the receiver fix.
- `X-EBAY-SIGNATURE` was present.
- Signature verification now succeeds.
- Ledger rows are inserted/updated.
- Targeted sync is requested.
- The generated sync runs are targeted, not archive/backfill sweeps.
- Safety holds: `messagesSent = 0`, no send endpoint calls, no unintended eBay mutations.

What failed:

- The eBay subscription-test notification uses a synthetic conversation id.
- The Message API rejects that synthetic id with 404 `Invalid conversation`.
- Notification processing ends at `sync_failed`.
- `sync_run_id` remains null on the notification ledger row.
- Canonical mailbox is not updated by webhook-driven sync.
- Dashboard notification event remains failed, not succeeded.

Core criterion:

```text
signature_verified = true
processing_status = sync_succeeded
sync_run_id is not null
```

Status:

```text
Not met.
```

Important interpretation:

```text
The deployed signature fix works.
The remaining validation blocker is that eBay subscription-test NEW_MESSAGE payloads are signed but synthetic and not retrievable from Commerce Message API.
```

## Evidence

### Notification Row

Latest post-fix subscription-test notification:

```json
{
  "id": "247c098d-f4b1-494a-bf31-c14f97d90a9e",
  "notification_id": "2d447f78-e5f6-44b9-b6d6-e3ed50554d83_7502d1d9-ca73-49f9-8e56-1433edf9eab9",
  "topic": "NEW_MESSAGE",
  "event_date": "2026-06-08T03:58:38.241+00:00",
  "publish_date": "2026-06-08T04:01:25.476+00:00",
  "received_at": "2026-06-08T03:58:38.978984+00:00",
  "processed_at": "2026-06-08T04:01:44.982+00:00",
  "signature_verified": true,
  "signature_verification_error": null,
  "processing_status": "sync_failed",
  "ebay_conversation_id": "9394020427474",
  "conversation_type": "FROM_MEMBERS",
  "ebay_message_id": "5498561796019",
  "sync_run_id": null,
  "sync_response": {
    "error": "targeted_sync_failed:502:ebay_api_get_failed"
  }
}
```

Earlier post-deploy retry of the previous failed notification also changed from `Not implemented` to verified:

```json
{
  "id": "15ba2af5-ec66-49a7-9ea4-d368d86c6de3",
  "notification_id": "34875b91-ebec-4567-8177-6dccda56bd1d_ead0bed0-ee6e-490c-acd3-9678d3d76968",
  "topic": "NEW_MESSAGE",
  "signature_verified": true,
  "signature_verification_error": null,
  "processing_status": "sync_failed",
  "ebay_conversation_id": "9394020427474",
  "ebay_message_id": "5498561796019",
  "sync_run_id": null
}
```

Conclusion:

```text
The signature compatibility fix is working in production.
```

### Targeted Sync Evidence

Latest failed targeted sync run created by the notification receiver:

```json
{
  "id": "4a64970b-95e8-4c40-bb4e-7776bf6f0e13",
  "status": "failed",
  "run_type": "manual",
  "trigger_source": "service_role",
  "started_at": "2026-06-08T04:01:36.164224+00:00",
  "completed_at": "2026-06-08T04:01:44.877+00:00",
  "conversation_page_limit": 1,
  "message_page_limit": 50,
  "max_conversation_pages": 0,
  "max_detail_pages_per_conversation": 20,
  "pages_fetched": 0,
  "detail_pages_fetched": 0,
  "conversations_seen": 0,
  "messages_seen": 0,
  "messages_inserted": 0,
  "messages_updated": 0,
  "errors": 1,
  "last_error_code": "ebay_api_get_failed",
  "metadata": {
    "conversationId": "9394020427474",
    "conversationTypes": [
      "FROM_MEMBERS"
    ]
  }
}
```

Provider error:

```text
GET /commerce/message/v1/conversation/9394020427474?conversation_type=FROM_MEMBERS&limit=50&offset=0 failed (404): M2MChatEntityClient:getConversationById: Invalid conversation | errorId:355000 | domain:API_MESSAGE | category:APPLICATION
```

No archive/backfill sweep:

```text
run_type = manual
conversation_page_limit = 1
message_page_limit = 50
pages_fetched = 0
detail_pages_fetched = 0
conversations_seen = 0
messages_seen = 0
```

Safety:

```text
messagesSent = 0
send endpoints called = 0
ebayMutationsPerformed = false
```

### Canonical Mailbox Evidence

Canonical lookup for the eBay test conversation:

```json
{
  "conversation": {
    "status": 200,
    "count": 0,
    "rows": []
  }
}
```

Interpretation:

```text
The eBay subscription-test conversation id is not a real retrievable conversation in OG canonical storage or eBay Commerce Message API.
```

Mailbox Playwright smoke:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T04-00-31-726Z.md
Result: 2 passed
Blocked send attempts: 0
```

Mailbox RPC/UI evidence:

```json
{
  "canonical_total": 483,
  "matching_total": 483,
  "loaded_count": 100,
  "uiSummary": "CANONICAL: 483\nMatching: 483\nLOADED: 100\nDisplayed: 100\nMEMBERS: 299\neBay Notifications: 184\nUNREAD: 12\nUnclassified: 0\nLABELS: 0\n105 returns · RPC v2_provider_read_state"
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

Dashboard evidence:

```json
{
  "id": "5a8c6e28-a09e-4af9-9fbf-60174c0d0401",
  "event_type": "provider_notification_received",
  "status": "failed",
  "title": "eBay notification received",
  "created_at": "2026-06-08T03:58:56.596616+00:00"
}
```

The dashboard event is correctly failed because the targeted sync failed.

## Regression Validation

Required command:

```sh
npm run test:email-triage
```

Result:

```text
2 passed
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T04-00-31-726Z.md
Blocked send attempts: 0
```

Optional command:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

First attempt failed because the sandbox blocked the local Python web server bind:

```text
PermissionError: [Errno 1] Operation not permitted
```

Rerun with approved escalation passed:

```text
2 passed
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T04-03-21-457Z.md
Blocked send attempts: 0
```

Sync Recent evidence:

```json
{
  "runId": "2070dcd4-0745-44ba-b71e-9fb126f74b27",
  "canonicalTotalConversations": 485,
  "pagesFetched": 2,
  "conversationsSeen": 107,
  "conversationsInserted": 2,
  "messagesSeen": 587,
  "messagesInserted": 2,
  "messagesRechecked": 585,
  "canonicalDetailSweepCandidates": 100,
  "canonicalDetailSweepRefreshed": 100,
  "warningsCount": 0,
  "safety": {
    "readOnly": true,
    "ebayMutationsPerformed": false,
    "sendsEnabled": false,
    "messagesSent": 0
  }
}
```

Refresh Timeline evidence:

```json
{
  "runId": "bb2f5062-f816-494b-aa39-745c75e201d7",
  "conversationId": "208004455199",
  "conversationTypes": [
    "FROM_EBAY"
  ],
  "conversationPageLimit": 1,
  "messagePageLimit": 50,
  "maxConversationPages": 1,
  "conversationsSeen": 1,
  "messagesSeen": 1,
  "messagesRechecked": 1,
  "canonicalDetailSweepCandidates": 0,
  "canonicalDetailSweepRefreshed": 0,
  "safety": {
    "readOnly": true,
    "ebayMutationsPerformed": false,
    "sendsEnabled": false,
    "messagesSent": 0
  }
}
```

## Safety Validation

```text
Blocked send attempts: 0
messagesSent: 0
No send_message endpoint called
No unintended eBay mutations
```

The eBay notification admin test action reported:

```json
{
  "httpStatus": 200,
  "ok": true,
  "actionStatuses": {
    "test": {
      "status": 202
    }
  },
  "capability": {
    "liveDeliveryActive": true,
    "destinationEnabled": true,
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

This mutation was limited to requesting eBay's subscription test notification. It did not send messages or mutate message state.

## Remaining Issues

1. Full webhook-driven sync is still unproven because no real buyer/member message was received during this validation.

2. eBay subscription-test notifications are signed and useful for receiver validation, but their synthetic conversation id is not retrievable from Commerce Message API:

```text
conversationId = 9394020427474
messageId = 5498561796019
provider result = 404 Invalid conversation
```

3. Notification ledger `sync_run_id` remains null on sync failure even though a targeted sync run is created. The sync run id is present in `ebay_message_sync_runs`, but the notification receiver only stores `sync_run_id` from successful sync responses.

4. The receiver returns a failed provider notification event for eBay subscription tests because targeted sync fails. This is accurate for the current implementation, but it means subscription tests will not produce green dashboard evidence.

5. To satisfy the final criterion, the next validation needs an actual eBay buyer/member message that produces a retrievable `conversationId`.

## Deployment Requirements

Migration required?

```text
No.
```

Edge Function deploy required?

```text
No for the already-deployed signature compatibility fix.
```

Optional future Edge Function improvement:

```text
Consider recording failed sync run ids back to ebay_message_notifications, and consider treating known eBay subscription-test synthetic notifications as delivery/signature tests instead of retry-worthy sync failures.
```

Frontend deploy required?

```text
No.
```

New secrets required?

```text
No.
```

eBay reconnect required?

```text
No.
```

Developer console changes required?

```text
No.
```

The destination and subscription remain enabled and live.

## Beta Readiness

Updated estimate:

```text
93%
```

Reason:

```text
The highest-risk unknown moved forward: real eBay-signed delivery now verifies successfully in production. The remaining blocker is proving the same path on a real retrievable buyer/member conversation rather than eBay's synthetic subscription-test conversation.
```

## Final Decision

Can we now move to:

```text
5F.6M - Controlled Return Messaging
```

Answer:

```text
No.
```

Reason:

```text
The required final state was not reached:
signature_verified = true passed,
but processing_status = sync_succeeded failed,
and sync_run_id is not populated on the notification row.
```

Exact next action:

```text
Validate with an actual eBay buyer/member message that produces a real Commerce Message API conversationId.
```

Pass condition remains:

```text
signature_verified = true
processing_status = sync_succeeded
sync_run_id is not null
canonical conversation updated or rechecked
dashboard provider_notification_received event is succeeded
messagesSent = 0
```
