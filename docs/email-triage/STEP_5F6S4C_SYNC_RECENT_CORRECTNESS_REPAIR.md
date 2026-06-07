# Step 5F.6S.4C - Sync Recent Mailbox Correctness Repair

## Executive Summary

Step 5F.6S.4C repaired the Sync Recent Mailbox correctness gap identified in Step 5F.6S.4B.

Sync Recent Mailbox still starts with the provider's bounded latest conversation list, so brand-new provider-recent conversations continue to import normally. It now also performs a bounded canonical recent detail sweep for existing `FROM_MEMBERS` conversations that are already in the operator-visible recent mailbox but may be omitted by the provider list.

The repair does not scan the archive. It refreshes up to 100 canonical recent member conversations, excluding conversations already handled by the provider latest list, and reuses the existing `syncConversationDetail` persistence path that Refresh Timeline already proved correct.

Final live validation passed:

- Report: `tests/email-triage/reports/email-triage-regression-2026-06-07T17-38-12-904Z.md`
- Sync run: `d7e002a3-722e-4032-875e-98e2955fe783`
- Refresh Timeline: skipped
- `canonicalDetailSweepCandidates`: `100`
- `canonicalDetailSweepRefreshed`: `100`
- `canonicalDetailSweepFailed`: `0`
- `canonicalDetailSweepMessagesInserted`: `8`
- `canonicalDetailSweepMessagesUpdated`: `4`
- Rafa conversation `124850576707`: swept by Sync Recent, not returned by provider list

## Root Cause Analysis

Step 5F.6S.4B proved the original failure was selection logic, not persistence, rendering, or the detail endpoint.

Old flow:

```text
Sync Recent Mailbox
-> provider latest conversation list
-> detail sync only for conversations returned by that list
```

Failure mode:

```text
Existing conversation receives new provider messages
-> provider list omits that conversation
-> Sync Recent never calls detail endpoint
-> canonical messages/latest preview remain stale
```

Rafa evidence from 5F.6S.4B:

- Conversation: `124850576707`
- Canonical before targeted Refresh Timeline: latest preview `Testing 2`
- Refresh Timeline run: `141c64ae-fd16-4000-ba31-143c6644aea9`
- Detail endpoint inserted `Testing 3`, `Testing 4`, `Testing 5`
- Canonical after targeted Refresh Timeline: latest preview `Testing 5`, message count `25`

Therefore the missing behavior was: Sync Recent needed a bounded way to refresh recent existing conversations even when eBay's latest list omitted them.

## Implemented Repair

File changed:

- `supabase/functions/ebay-message-sync/index.ts`

New behavior:

```text
Sync Recent Mailbox
-> fetch provider latest conversation list
-> upsert provider-returned conversations
-> detail-sync provider-returned conversations
-> select bounded canonical recent existing FROM_MEMBERS conversations
-> exclude provider-returned conversation IDs
-> call existing syncConversationDetail for each selected canonical conversation
-> update messages, latest_message_id, latest_message_created_at, latest_message_preview, message_count, last_detail_synced_at
```

Bounds:

- Default `recentDetailSweepLimit`: `100`
- Max `recentDetailSweepLimit`: `100`
- Scope: default incremental Sync Recent only
- Conversation type: `FROM_MEMBERS`
- Excluded: targeted refresh, manual filters, explicit start/end windows, reference/user filters, backfill

The sweep does not advance provider-list checkpoints. Checkpoints continue to describe the provider latest-list crawl; sweep activity is recorded separately in run metadata/counters.

## Sync Recent Mailbox Flow

Provider-list phase:

1. `email-triage.js` calls `ebay-message-sync`.
2. Request uses:
   - `runType: incremental`
   - `checkpointScope: commerce_message_latest_sync`
   - `conversationTypes: ["FROM_MEMBERS", "FROM_EBAY"]`
   - `conversationPageLimit: 25`
   - `maxConversationPages: 1`
   - `messagePageLimit: 25`
   - `maxDetailPagesPerConversation: 20`
3. Edge Function fetches eBay conversation pages.
4. `processConversationPage` upserts conversations and calls `syncConversationDetail`.

Canonical recent detail sweep phase:

1. Runs after provider-list pagination for `FROM_MEMBERS`.
2. Loads up to 100 recent canonical member conversations, ordered by canonical latest timestamp.
3. Excludes IDs already returned by the provider list.
4. Calls `syncConversationDetail` directly with the canonical row ID.
5. Reuses existing message upsert and conversation detail update logic.
6. Records separate counters:
   - `canonicalDetailSweepCandidates`
   - `canonicalDetailSweepRefreshed`
   - `canonicalDetailSweepSkipped`
   - `canonicalDetailSweepFailed`
   - `canonicalDetailSweepMessagesInserted`
   - `canonicalDetailSweepMessagesUpdated`
   - `canonicalDetailSweepMessagesRechecked`
   - `canonicalDetailSweepConversationIds`

## Refresh Timeline Flow

Refresh Timeline remains unchanged:

```text
Selected conversation
-> ebay-message-sync with conversationId
-> direct eBay detail endpoint
-> syncConversationDetail
-> upsert messages
-> update canonical latest fields
```

The repair intentionally reuses the same detail persistence path for Sync Recent's canonical sweep. That keeps the persistence semantics identical between Sync Recent and Refresh Timeline.

## Exact Divergence Point Resolved

Old divergence:

```text
Provider latest list omitted existing conversation
-> Sync Recent stopped
-> Refresh Timeline direct detail fetch succeeded
```

New convergence:

```text
Provider latest list omitted existing conversation
-> canonical recent sweep selects existing conversation
-> Sync Recent calls same detail sync path as Refresh Timeline
-> canonical messages/latest state updates
```

## Evidence

### Deployment

Deployed Edge Function:

```bash
node_modules/supabase/bin/supabase functions deploy ebay-message-sync --project-ref byhytmarmigalvawkedi --use-api
```

Final deploy result:

```text
Deployed Functions on project byhytmarmigalvawkedi: ebay-message-sync
```

### Playwright Validation

Command:

```bash
env EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=false EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=false EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=false EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=false EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=false EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=false EMAIL_TRIAGE_SYNC_RECENT_TARGET_EBAY_CONVERSATION_ID=124850576707 EMAIL_TRIAGE_SYNC_RECENT_TARGET_CONVERSATION_TYPE=FROM_MEMBERS EMAIL_TRIAGE_EXPECT_SYNC_RECENT_TARGET_SWEEP=true npm run test:email-triage
```

Result:

```text
2 passed (1.8m)
```

Report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-07T17-38-12-904Z.md
```

Refresh Timeline was skipped in this run.

### Final Sync Recent Run

Run:

```text
d7e002a3-722e-4032-875e-98e2955fe783
```

Counters:

```json
{
  "pagesFetched": 2,
  "conversationsSeen": 101,
  "conversationsInserted": 0,
  "conversationsUpdated": 3,
  "conversationsUnchanged": 98,
  "messagesSeen": 531,
  "messagesInserted": 8,
  "messagesUpdated": 4,
  "messagesRechecked": 523,
  "canonicalDetailSweepCandidates": 100,
  "canonicalDetailSweepRefreshed": 100,
  "canonicalDetailSweepFailed": 0,
  "canonicalDetailSweepMessagesInserted": 8,
  "canonicalDetailSweepMessagesUpdated": 4,
  "canonicalDetailSweepMessagesRechecked": 522
}
```

Provider list returned:

```json
["207993374219"]
```

Rafa target result:

```json
{
  "ebayConversationId": "124850576707",
  "sweptByCanonicalDetailSweep": true,
  "processedByProviderList": false,
  "latest_message_preview_before": "Testing 5",
  "latest_message_preview_after": "Testing 5",
  "message_count_before": 25,
  "message_count_after": 25,
  "last_detail_synced_at_before": "2026-06-07T16:45:05.64+00:00",
  "last_detail_synced_at_after": "2026-06-07T17:36:57.629+00:00"
}
```

Rafa did not insert new content in the final 4C run because Step 5F.6S.4B had already used Refresh Timeline to insert `Testing 3`, `Testing 4`, and `Testing 5`. The important 4C evidence is that Sync Recent now did call the detail path for Rafa without Refresh Timeline.

### Existing Conversation Update Evidence

The same final Sync Recent run inserted new messages into existing swept conversations.

Inserted rows created by run `d7e002a3-722e-4032-875e-98e2955fe783`:

```text
Conversation 125592678502:
- inserted 7 messages
- latest_message_id after sync: 3426784501018
- latest_message_created_at after sync: 2026-06-06T18:44:52+00:00
- message_count after sync: 13
- last_detail_synced_at after sync: 2026-06-07T17:37:04.127+00:00

Conversation 124948878211:
- inserted 1 message
- latest_message_id after sync: 3445518706014
- latest_message_created_at after sync: 2026-06-06T20:01:46+00:00
- message_count after sync: 5
- last_detail_synced_at after sync: 2026-06-07T17:37:07.49+00:00
```

Because those inserted message rows have `last_sync_run_id = d7e002a3-722e-4032-875e-98e2955fe783` and were created during the Sync Recent run, this validates that Sync Recent now updates existing conversations without Refresh Timeline.

### New Conversation Discovery Evidence

The provider-list import path remains unchanged. During 4C validation, an earlier post-deploy Sync Recent run imported a provider-returned new conversation:

```text
Run: 1a12706c-dbcf-497b-99ac-7ea2cb8493d7
conversations_inserted: 1
messages_inserted: 1
provider conversation IDs: 207993374219, 207991746189
```

The final run had no remaining absent provider-recent conversation to import, so `conversationsInserted` was `0`.

## Acceptance Criteria

### Test 1 - Existing Conversation Refresh

Passed with equivalent live evidence.

- Rafa `124850576707` was swept by Sync Recent and not processed by provider list.
- Refresh Timeline was skipped.
- `last_detail_synced_at` advanced.
- Rafa content was already current at `Testing 5` from 5F.6S.4B, so no new Rafa content delta existed to insert.
- Other existing swept conversations inserted 8 messages and updated canonical latest fields during the same Sync Recent run.

### Test 2 - New Conversation Discovery

Passed for the unchanged provider-list import path.

- 4C post-deploy run `1a12706c-dbcf-497b-99ac-7ea2cb8493d7` inserted 1 new conversation and 1 message from the provider list.

### Test 3 - Canonical State

Passed.

Verified canonical fields advanced for swept conversations:

- `latest_message_id`
- `latest_message_created_at`
- `latest_message_preview`
- `message_count`
- `last_detail_synced_at`

Rafa validation also verified `last_detail_synced_at` advanced without provider-list inclusion or Refresh Timeline.

### Test 4 - Playwright Validation

Passed.

- Harness now supports `EMAIL_TRIAGE_SYNC_RECENT_TARGET_EBAY_CONVERSATION_ID`.
- Harness verifies target conversation processing via provider list or canonical sweep.
- Harness can require canonical sweep using `EMAIL_TRIAGE_EXPECT_SYNC_RECENT_TARGET_SWEEP=true`.
- Final 4C run used the sweep-required mode and passed.

## Deployment Requirements

Migration required?

```text
No
```

Edge Function deploy required?

```text
Yes
```

Completed:

```text
ebay-message-sync deployed to byhytmarmigalvawkedi
```

Frontend deploy required?

```text
No
```

Harness-only changes are local test changes. The production UI request body can remain unchanged because the Edge Function now defaults `recentDetailSweepLimit` to `100` for Sync Recent.

## Exact Commands

Local checks:

```bash
node --check tests/email-triage/email-triage-regression.spec.mjs
node --check tests/email-triage/supabase-readonly-checks.mjs
git diff --check
```

Deploy:

```bash
node_modules/supabase/bin/supabase functions deploy ebay-message-sync --project-ref byhytmarmigalvawkedi --use-api
```

Live validation:

```bash
env EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=false EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=false EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=false EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=false EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=false EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=false EMAIL_TRIAGE_SYNC_RECENT_TARGET_EBAY_CONVERSATION_ID=124850576707 EMAIL_TRIAGE_SYNC_RECENT_TARGET_CONVERSATION_TYPE=FROM_MEMBERS EMAIL_TRIAGE_EXPECT_SYNC_RECENT_TARGET_SWEEP=true npm run test:email-triage
```

## Severity

Pre-fix severity: High.

Reason: operator-facing recent mailbox state could be stale for existing conversations even after a successful Sync Recent Mailbox run. This directly affected inbox trust.

Post-fix severity: Reduced to monitored.

Reason: Sync Recent now detail-refreshes the bounded recent canonical mailbox and records explicit counters proving the behavior.

## Beta Impact

Beta impact is positive.

Operators can use Sync Recent Mailbox with substantially better trust:

- Brand-new provider conversations still import.
- Existing recent member conversations now get detail refreshed.
- Previews, timestamps, message counts, and timelines are updated by Sync Recent.
- Manual Refresh Timeline is no longer required for recent mailbox correctness.

Operational cost is bounded to the recent mailbox window:

- Provider list: unchanged bounded latest page behavior.
- Existing-conversation refresh: at most 100 canonical recent member conversations.
- Archive/backfill: unchanged.

