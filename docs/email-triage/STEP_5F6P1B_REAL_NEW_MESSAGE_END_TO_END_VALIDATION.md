# Step 5F.6P.1B - Real NEW_MESSAGE End-to-End Validation

Date: 2026-06-08

Scope: validate a real buyer/member eBay `NEW_MESSAGE` from `rafa1-6` with body `Testing 9` from notification ingress through targeted sync, canonical mailbox, and dashboard visibility.

## Executive Summary

Result: **Pass.**

The real buyer/member message path now works end to end:

```text
Buyer sends message on eBay
-> eBay emits signed NEW_MESSAGE
-> OG receives notification
-> signature_verified = true
-> ledger row created
-> targeted sync succeeds
-> sync_run_id populated
-> canonical conversation updates automatically
-> mailbox RPC reflects latest message
-> dashboard shows succeeded notification event
```

No manual Sync Recent or Refresh Timeline was required for the target message.

Validated target:

```text
buyer = rafa1-6
message = Testing 9
conversationId = 124850576707
messageId = 3429373760017
conversationType = FROM_MEMBERS
```

Final decision:

```text
Yes, move to 5F.6M - Controlled Return Messaging.
```

## Required Audit

Did a NEW_MESSAGE notification arrive?

```text
Yes.
```

Was `signature_verified = true`?

```text
Yes.
```

Was a ledger row created?

```text
Yes.
```

Was a sync run created?

```text
Yes.
```

Did targeted sync succeed?

```text
Yes.
```

Was the conversation refreshed automatically?

```text
Yes.
```

Did the mailbox preview update automatically?

```text
Yes.
```

Did the dashboard update automatically?

```text
Yes.
```

Was Sync Recent required?

```text
No.
```

Was Refresh Timeline required?

```text
No.
```

## Notification Evidence

Latest successful notification ledger row for the target message:

```json
{
  "id": "b6a5ab97-7c42-453f-86d2-0586a4f564f3",
  "notification_id": "bec65ccd-2e28-411f-ae8f-3c8f5e7426ed_c132bed5-b9e3-4abc-ba2a-8fb08f641b50",
  "topic": "NEW_MESSAGE",
  "event_date": "2026-06-08T04:10:17.092+00:00",
  "publish_date": "2026-06-08T04:13:18.518+00:00",
  "received_at": "2026-06-08T04:10:17.814853+00:00",
  "processed_at": "2026-06-08T04:13:38.142+00:00",
  "signature_verified": true,
  "signature_verification_error": null,
  "processing_status": "sync_succeeded",
  "ebay_conversation_id": "124850576707",
  "conversation_type": "FROM_MEMBERS",
  "ebay_message_id": "3429373760017",
  "sync_run_id": "654f527a-f91c-4df7-9202-2fd01d21a847"
}
```

Notification payload summary:

```json
{
  "conversationId": "124850576707",
  "conversationType": "FROM_MEMBERS",
  "messageId": "3429373760017",
  "messageBody": "Testing 9",
  "readStatus": false
}
```

Note:

```text
eBay retried the same notification id. The ledger is idempotent by notification_id, so the row currently points to the later successful retry run 654f527a-f91c-4df7-9202-2fd01d21a847. The first successful delivery at 04:10 inserted the new message through run b47ffb87-16e7-4aef-822f-e0ba413bf396.
```

## Sync Evidence

First successful webhook-triggered sync that inserted the target message:

```json
{
  "id": "b47ffb87-16e7-4aef-822f-e0ba413bf396",
  "status": "succeeded",
  "run_type": "manual",
  "trigger_source": "service_role",
  "started_at": "2026-06-08T04:10:27.239395+00:00",
  "completed_at": "2026-06-08T04:10:38.306+00:00",
  "conversation_type": "FROM_MEMBERS",
  "conversation_page_limit": 1,
  "message_page_limit": 50,
  "max_conversation_pages": 0,
  "max_detail_pages_per_conversation": 20,
  "pages_fetched": 0,
  "detail_pages_fetched": 2,
  "conversations_seen": 1,
  "conversations_updated": 1,
  "messages_seen": 31,
  "messages_inserted": 1,
  "messages_updated": 0,
  "errors": 0,
  "warnings": [],
  "metadata": {
    "conversationId": "124850576707",
    "conversationTypes": [
      "FROM_MEMBERS"
    ],
    "messagesRechecked": 30,
    "canonicalDetailSweepCandidates": 0,
    "canonicalDetailSweepRefreshed": 0,
    "ebayMutationsPerformed": false,
    "sendsEnabled": false
  }
}
```

Current ledger-linked successful retry sync:

```json
{
  "id": "654f527a-f91c-4df7-9202-2fd01d21a847",
  "status": "succeeded",
  "run_type": "manual",
  "trigger_source": "service_role",
  "started_at": "2026-06-08T04:13:27.686545+00:00",
  "completed_at": "2026-06-08T04:13:38.054+00:00",
  "conversation_type": "FROM_MEMBERS",
  "conversation_page_limit": 1,
  "message_page_limit": 50,
  "max_conversation_pages": 0,
  "max_detail_pages_per_conversation": 20,
  "pages_fetched": 0,
  "detail_pages_fetched": 2,
  "conversations_seen": 1,
  "messages_seen": 31,
  "messages_inserted": 0,
  "messages_updated": 0,
  "errors": 0,
  "warnings": [],
  "metadata": {
    "conversationId": "124850576707",
    "conversationTypes": [
      "FROM_MEMBERS"
    ],
    "messagesRechecked": 31,
    "canonicalDetailSweepCandidates": 0,
    "canonicalDetailSweepRefreshed": 0,
    "ebayMutationsPerformed": false,
    "sendsEnabled": false
  }
}
```

No archive scan or large sweep:

```text
conversation_page_limit = 1
message_page_limit = 50
pages_fetched = 0
conversations_seen = 1
canonicalDetailSweepCandidates = 0
canonicalDetailSweepRefreshed = 0
```

Safety:

```text
messagesSent = 0
ebayMutationsPerformed = false
sendsEnabled = false
```

## Mailbox Evidence

Canonical conversation:

```json
{
  "ebay_conversation_id": "124850576707",
  "conversation_type": "FROM_MEMBERS",
  "conversation_status": "ACTIVE",
  "conversation_title": "Testing 9",
  "latest_message_id": "3429373760017",
  "latest_message_created_at": "2026-06-08T04:10:16+00:00",
  "latest_message_preview": "Testing 9",
  "last_message_created_at": "2026-06-08T04:10:16+00:00",
  "message_count": 31,
  "last_synced_at": "2026-06-08T04:13:29.065+00:00",
  "last_detail_synced_at": "2026-06-08T04:13:29.064+00:00",
  "last_sync_run_id": "654f527a-f91c-4df7-9202-2fd01d21a847"
}
```

Target message:

```json
{
  "ebay_conversation_id": "124850576707",
  "conversation_type": "FROM_MEMBERS",
  "ebay_message_id": "3429373760017",
  "sender_username": "rafa1-6",
  "recipient_username": "ogjewelers",
  "direction": "inbound",
  "direction_confidence": "strong",
  "message_body_preview": "Testing 9",
  "is_read": false,
  "created_at_ebay": "2026-06-08T04:10:16+00:00",
  "last_sync_run_id": "654f527a-f91c-4df7-9202-2fd01d21a847"
}
```

Mailbox RPC search for `Testing 9`:

```json
{
  "ok": true,
  "rpc_version": "v2_provider_read_state",
  "canonical_total": 485,
  "matching_total": 1,
  "loaded_count": 1,
  "search_terms": [
    "testing 9"
  ],
  "conversation": {
    "ebay_conversation_id": "124850576707",
    "conversation_type": "FROM_MEMBERS",
    "latest_message_id": "3429373760017",
    "latest_message_preview": "Testing 9",
    "latest_message_created_at": "2026-06-08T04:10:16+00:00",
    "last_detail_synced_at": "2026-06-08T04:13:29.064+00:00",
    "provider_read_state": "read",
    "local_read_state": "read",
    "pending_provider_update": false
  }
}
```

Playwright non-mutating mailbox validation:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T04-16-26-684Z.md
Result: 2 passed
Blocked send attempts: 0
```

UI/mailbox evidence:

```json
{
  "canonical_total": 485,
  "matching_total": 485,
  "loaded_count": 100,
  "uiSummary": "CANONICAL: 485\nMatching: 485\nLOADED: 100\nDisplayed: 100\nMEMBERS: 299\neBay Notifications: 186\nUNREAD: 14\nUnclassified: 2\nLABELS: 0\n105 returns · RPC v2_provider_read_state"
}
```

Playwright selected conversation evidence:

```json
{
  "conversation_id": "b2659307-4dc3-4708-9b46-3735679a5398",
  "messages": {
    "count": 31,
    "lastCreatedAt": "2026-06-08T04:10:16+00:00",
    "lastMessageId": "3429373760017",
    "lastReadState": "null:false"
  },
  "uiMessageRows": 31
}
```

## Dashboard Evidence

Dashboard provider notification event:

```json
{
  "id": "ef73bf18-1b6f-4be1-afdf-a5ac3f428d23",
  "event_type": "provider_notification_received",
  "status": "succeeded",
  "title": "eBay notification received",
  "detail": "124850576707",
  "created_at": "2026-06-08T04:10:38.673413+00:00",
  "sync_run_id": "b47ffb87-16e7-4aef-822f-e0ba413bf396",
  "metadata": {
    "topic": "NEW_MESSAGE",
    "ebay_conversation_id": "124850576707",
    "ebay_message_id": "3429373760017",
    "conversation_type": "FROM_MEMBERS",
    "signature_verified": true,
    "sync_run_id": "b47ffb87-16e7-4aef-822f-e0ba413bf396",
    "sync_response": {
      "ok": true,
      "runId": "b47ffb87-16e7-4aef-822f-e0ba413bf396",
      "counters": {
        "conversationsSeen": 1,
        "messagesSeen": 31,
        "messagesInserted": 1,
        "messagesUpdated": 0,
        "messagesRechecked": 30,
        "canonicalDetailSweepCandidates": 0,
        "canonicalDetailSweepRefreshed": 0
      }
    }
  }
}
```

Playwright dashboard evidence:

```json
{
  "dashboardStatus": "Operational dashboard refreshed Jun 08, 2026, 12:16 AM.",
  "recentEvents": [
    {
      "event_type": "conversation_synced",
      "status": "succeeded",
      "title": "Conversation synced",
      "created_at": "2026-06-08T04:13:29.111527+00:00"
    },
    {
      "event_type": "provider_notification_received",
      "status": "succeeded",
      "title": "eBay notification received",
      "created_at": "2026-06-08T04:10:38.673413+00:00"
    }
  ]
}
```

## Manual Sync / Refresh Timeline Check

No manual Sync Recent or Refresh Timeline was used to prove the target update.

Relevant sequence:

```text
04:03Z - prior optional Refresh Timeline regression completed before this buyer message existed
04:10:16Z - buyer message Testing 9 created on eBay
04:10:17Z - NEW_MESSAGE notification received
04:10:27Z - webhook-triggered targeted sync started
04:10:38Z - webhook-triggered targeted sync completed and dashboard event succeeded
04:16Z - non-mutating Playwright smoke observed the already-updated mailbox/dashboard
```

The Playwright validation run explicitly skipped Sync Recent and Refresh Timeline:

```text
Sync recent mailbox: skipped
Refresh Timeline: skipped
```

## Remaining Gaps

The first successful real `NEW_MESSAGE` path is proven.

Remaining architecture work is broader-topic expansion, not a blocker for this step:

- Add or activate additional eBay notification topics as beta scope expands.
- Define per-topic targeted handlers for returns, refunds, cases, cancellations, and system notifications.
- Decide whether read/unread provider events can be event-driven or should remain polling/reconciliation-driven.
- Consider a realtime frontend subscription so already-open browsers update without manual reload/poll timing.
- Keep Sync Recent as a fallback safety net for missed notifications, destination downtime, and provider retry gaps.

## Deployment Requirements

Migration required?

```text
No.
```

Edge Function deploy required?

```text
No.
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

## Beta Readiness

Updated estimate:

```text
96%
```

Why:

```text
The highest-priority sync architecture proof is now complete: a real eBay buyer/member message updated OG automatically through webhook-driven targeted sync.
```

## Final Decision

Can we now move to:

```text
5F.6M - Controlled Return Messaging
```

Answer:

```text
Yes.
```

Do we still need another synchronization step before 5F.6M?

```text
No.
```

Recommended posture for 5F.6M:

```text
Proceed with Controlled Return Messaging while preserving Sync Recent as a fallback reconciliation job and tracking broader notification-topic expansion separately.
```
