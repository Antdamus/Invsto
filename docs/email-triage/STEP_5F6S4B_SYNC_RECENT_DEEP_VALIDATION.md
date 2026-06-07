# Step 5F.6S.4B Sync Recent Deep Validation

Audit date: 2026-06-07

Scope: audit and validation only. No fixes, migrations, Edge Function edits, frontend edits, or deploys were performed. Live validation did run Sync Recent Mailbox and Refresh Timeline against the same existing conversation, which created normal sync run rows and updated canonical message state.

## Executive Summary

Sync Recent Mailbox can discover brand new conversations and new messages in existing conversations only when the eBay conversation list endpoint returns those conversations in its bounded latest-sync page/window.

It is not a reliable existing-conversation delta fetch.

The `rafa1-6` case is now root-caused:

```text
Sync Recent Mailbox did not show Testing 3 / Testing 4 / Testing 5
because the batch conversation-list phase did not return conversation 124850576707.
Since the conversation was not in that list, Sync Recent never called the detail endpoint
for that conversation and never reached message persistence for those messages.

Refresh Timeline succeeded because it bypassed the list/checkpoint selection phase and
called the conversation detail endpoint directly for 124850576707.
```

The exact observed classification for Q4 is:

```text
A. provider never returned the conversation to the Sync Recent list path
```

More precisely: the provider detail endpoint returned the missing messages when called directly, but the provider conversation list endpoint used by Sync Recent did not include `124850576707` in the Sync Recent batch selection.

## Sources Reviewed

Required prior docs:

- `docs/email-triage/STEP_5F6S_COMPREHENSIVE_REGRESSION_AUDIT.md`
- `docs/email-triage/STEP_5F6S3_HIGH_RISK_WORKFLOW_VALIDATION.md`
- `docs/email-triage/STEP_5F6S4_LONG_RUNNING_WORKFLOW_RECONCILIATION.md`
- `docs/email-triage/STEP_5F6S4_POST_DEPLOY_VALIDATION.md`
- `docs/email-triage/STEP_5F6S4A_RECLASSIFY_TERMINALIZATION_FIX.md`

Code reviewed:

- `email-triage.js`
- `email-triage.api.js`
- `supabase/functions/ebay-message-sync/index.ts`
- `supabase/migrations/20260606170000_ebay_unclassified_queue_visibility.sql`
- `tests/email-triage/email-triage-regression.spec.mjs`
- `tests/email-triage/supabase-readonly-checks.mjs`

Reports reviewed:

- `tests/email-triage/reports/email-triage-regression-2026-06-07T05-10-41-785Z.md`
- `tests/email-triage/reports/email-triage-regression-2026-06-07T06-19-59-102Z.md`
- `tests/email-triage/reports/email-triage-regression-2026-06-07T16-02-10-841Z.md`

## Root Cause Analysis

The backend has two materially different branches inside `ebay-message-sync`.

Sync Recent uses the batch branch:

```text
GET /commerce/message/v1/conversation
  ?conversation_type=FROM_MEMBERS
  &limit=25
  &offset=0
  &start_time=<latest checkpoint timestamp>

GET /commerce/message/v1/conversation
  ?conversation_type=FROM_EBAY
  &limit=25
  &offset=0
```

Only conversations returned by those list calls are passed to `processConversationPage(...)`. Only then does the function call:

```text
GET /commerce/message/v1/conversation/{conversationId}
  ?conversation_type=<type>
  &limit=25
  &offset=<detail offset>
```

Refresh Timeline uses the targeted branch:

```text
GET /commerce/message/v1/conversation/124850576707
  ?conversation_type=FROM_MEMBERS
  &limit=50
  &offset=0
```

That targeted branch does not depend on latest-sync checkpoints or the conversation list endpoint.

For `rafa1-6`, Sync Recent run `4003a547-710a-43fc-9514-3b851089362f` returned 18 conversation IDs:

```text
125150025407
124771994601
124771998701
125790734200
207991746189
207991745809
207991572859
207991457699
207991451329
207990678049
207990677049
207990610489
207990609179
207990609079
207990608459
207988879509
207988847889
207982197719
```

The target conversation `124850576707` is not in that list. Therefore detail sync was skipped for this conversation by selection, not by persistence failure.

## Sync Recent Mailbox Flow

Frontend entry:

- `email-triage.js:5710` calls `runEbayConversationImport(...)` with `runType: "incremental"`, `checkpointScope: "commerce_message_latest_sync"`, `latestSyncLookbackDays: 14`, and `reloadLimit: 100`.
- `email-triage.js:5807` sends `conversationPageLimit: 25`, `messagePageLimit: 25`, `maxConversationPages: 1`, and `maxDetailPagesPerConversation: 20`.
- `email-triage.api.js:1590` serializes the body for `ebay-message-sync`.

Backend input handling:

- `supabase/functions/ebay-message-sync/index.ts:288` parses optional `conversationId`.
- `supabase/functions/ebay-message-sync/index.ts:300` sets `maxConversationPages` to `0` only when `conversationId` exists. Sync Recent has no `conversationId`, so it remains a batch operation.

Batch selection:

- `supabase/functions/ebay-message-sync/index.ts:1680` begins incremental checkpoints.
- `supabase/functions/ebay-message-sync/index.ts:1697` computes the incremental cutoff from checkpoint state.
- `supabase/functions/ebay-message-sync/index.ts:1698` applies that cutoff as `start_time` only for `FROM_MEMBERS`.
- `supabase/functions/ebay-message-sync/index.ts:1713` calls the conversation list endpoint.
- `supabase/functions/ebay-message-sync/index.ts:1720` reads `payload.conversations`.
- `supabase/functions/ebay-message-sync/index.ts:1724` passes only those conversations to `processConversationPage(...)`.

Detail fetching and persistence, only for selected conversations:

- `supabase/functions/ebay-message-sync/index.ts:1528` calls `syncConversationDetail(...)`.
- `supabase/functions/ebay-message-sync/index.ts:1052` calls the conversation detail endpoint.
- `supabase/functions/ebay-message-sync/index.ts:1061` calls `upsertMessages(...)`.
- `supabase/functions/ebay-message-sync/index.ts:981` upserts messages by `(seller_account_id, conversation_type, ebay_conversation_id, ebay_message_id)`.
- `supabase/functions/ebay-message-sync/index.ts:1074` calls `updateConversationFromDetail(...)`.
- `supabase/functions/ebay-message-sync/index.ts:1013` through `1016` update `latest_message_id`, `latest_message_created_at`, `latest_message_preview`, and `message_count`.

Checkpoint behavior:

- `supabase/functions/ebay-message-sync/index.ts:1218` reads `ebay_message_sync_checkpoints`.
- `supabase/functions/ebay-message-sync/index.ts:1111` uses `checkpoint.lastConversationTimestamp` for incremental start time when present.
- `supabase/functions/ebay-message-sync/index.ts:1359` updates `last_conversation_timestamp` from the newest timestamp in conversations actually processed.

## Refresh Timeline Flow

Frontend entry:

- `email-triage.js:5218` starts `refreshEbayConversationTimeline(...)`.
- `email-triage.js:5250` calls `runEbayMessageSync(...)` with:
  - `conversationId`
  - selected `conversationTypes`
  - `conversationPageLimit: 1`
  - `messagePageLimit: 50`
  - `maxDetailPagesPerConversation: 20`
- `email-triage.js:5259` reloads selected messages, drafts, and the mailbox after the sync response.

Backend targeted branch:

- `supabase/functions/ebay-message-sync/index.ts:1648` enters the `conversationId` branch.
- `supabase/functions/ebay-message-sync/index.ts:1649` calls the detail endpoint directly.
- `supabase/functions/ebay-message-sync/index.ts:1654` wraps the detail payload as a one-conversation page.
- `supabase/functions/ebay-message-sync/index.ts:1659` calls the same `processConversationPage(...)` persistence path used by batch sync.

Important detail:

Refresh Timeline does not use the latest-sync checkpoint, does not call the conversation list endpoint, and does not depend on whether the conversation appears in the latest page.

## Evidence

### Prior report evidence

Step 5F.6S.3 already showed the paths are different:

- Sync Recent request: `runType: incremental`, `checkpointScope: commerce_message_latest_sync`, `conversationPageLimit: 25`, `messagePageLimit: 25`, `maxConversationPages: 1`.
- Refresh Timeline request: `runType: manual`, `conversationId`, `conversationPageLimit: 1`, `messagePageLimit: 50`, `maxDetailPagesPerConversation: 20`.

That run did not prove positive member-message discovery because Sync Recent returned only one already-known `FROM_EBAY` conversation.

### Baseline before targeted validation

Target:

```text
DB conversation id: b2659307-4dc3-4708-9b46-3735679a5398
eBay conversation id: 124850576707
conversation_type: FROM_MEMBERS
```

Canonical state before the A/B run:

```text
latest_message_id: 3428995664017
latest_message_created_at: 2026-06-07T02:33:41+00:00
latest_message_preview: Testing 2
message_count: 22
last_detail_synced_at: 2026-06-07T02:41:00.331+00:00
```

Latest-sync checkpoint before the A/B run:

```text
FROM_MEMBERS last_run_id: eb0f155f-f0d5-4f08-9995-eb95ed907f78
FROM_MEMBERS last_conversation_timestamp: 2026-06-06T23:39:23+00:00
FROM_MEMBERS total_available: 0
FROM_MEMBERS conversations_processed: 0
FROM_MEMBERS messages_seen in checkpoint metadata: 0
```

### Sync Recent validation against the same conversation

Run:

```text
run_id: 4003a547-710a-43fc-9514-3b851089362f
started_at: 2026-06-07T16:44:32.936911+00:00
completed_at: 2026-06-07T16:44:53.371+00:00
status: succeeded
```

Request:

```json
{
  "runType": "incremental",
  "conversationTypes": ["FROM_MEMBERS", "FROM_EBAY"],
  "conversationPageLimit": 25,
  "messagePageLimit": 25,
  "maxConversationPages": 1,
  "maxDetailPagesPerConversation": 20,
  "checkpointScope": "commerce_message_latest_sync",
  "latestSyncLookbackDays": 14,
  "readOnly": true
}
```

Response summary:

```text
pagesFetched: 2
detailPagesFetched: 18
conversationsSeen: 18
conversationsInserted: 15
conversationsUpdated: 2
messagesSeen: 28
messagesInserted: 18
messagesRechecked: 10
```

Sync Recent did discover other new provider data. It did not discover `124850576707`.

After Sync Recent, `rafa1-6` was unchanged:

```text
latest_message_id: 3428995664017
latest_message_preview: Testing 2
message_count: 22
last_detail_synced_at: 2026-06-07T02:41:00.331+00:00
```

The Sync Recent run metadata conversation IDs did not include `124850576707`.

Latest-sync checkpoint after this run:

```text
FROM_MEMBERS last_run_id: 4003a547-710a-43fc-9514-3b851089362f
FROM_MEMBERS last_conversation_timestamp: 2026-06-07T15:25:12+00:00
FROM_MEMBERS total_available: 4
FROM_MEMBERS conversations_processed: 4
FROM_MEMBERS messages_seen in checkpoint metadata: 14
FROM_MEMBERS messages_inserted in checkpoint metadata: 5
```

That proves the member list path returned some conversations and messages, but not this existing conversation.

### Refresh Timeline validation against the same conversation

Run:

```text
run_id: 141c64ae-fd16-4000-ba31-143c6644aea9
started_at: 2026-06-07T16:45:04.391741+00:00
completed_at: 2026-06-07T16:45:13.024+00:00
status: succeeded
```

Request:

```json
{
  "runType": "manual",
  "conversationTypes": ["FROM_MEMBERS"],
  "conversationPageLimit": 1,
  "messagePageLimit": 50,
  "maxConversationPages": 1,
  "maxDetailPagesPerConversation": 20,
  "conversationId": "124850576707",
  "readOnly": true
}
```

Response summary:

```text
pagesFetched: 0
detailPagesFetched: 2
conversationsSeen: 1
conversationsUpdated: 1
messagesSeen: 25
messagesInserted: 3
messagesRechecked: 22
```

After Refresh Timeline:

```text
latest_message_id: 3429006808017
latest_message_created_at: 2026-06-07T03:52:39+00:00
latest_message_preview: Testing 5
message_count: 25
last_detail_synced_at: 2026-06-07T16:45:05.64+00:00
```

New messages inserted by targeted refresh:

```text
3428997120017 | Testing 3 | 2026-06-07T02:42:29+00:00
3428997762017 | Testing 4 | 2026-06-07T02:46:37+00:00
3429006808017 | Testing 5 | 2026-06-07T03:52:39+00:00
```

Browser/UI evidence:

```text
Before targeted refresh: selected row preview was Testing 2; UI did not contain Testing 5.
After targeted refresh: UI contained Testing 5, and canonical latest preview was Testing 5.
Blocked send attempts: 0
```

### Persistence and rendering evidence

Persistence is not the failing layer:

- `upsertMessages(...)` inserted the three missing rows during Refresh Timeline.
- `updateConversationFromDetail(...)` advanced the canonical latest fields.
- The mailbox RPC derives effective latest preview from `ebay_conversation_messages` and orders by `latest_message_created_at`.
- The UI rendered the updated timeline after the targeted refresh.

Therefore this is not an `ebay_conversation_messages` upsert bug and not a frontend rendering bug.

## Exact Divergence Point

The divergence occurs here:

```text
Sync Recent:
supabase/functions/ebay-message-sync/index.ts:1713
-> calls /commerce/message/v1/conversation
-> provider result does not include 124850576707
-> processConversationPage never receives 124850576707
-> syncConversationDetail is never called for 124850576707
-> Testing 3 / Testing 4 / Testing 5 are not persisted

Refresh Timeline:
supabase/functions/ebay-message-sync/index.ts:1648
-> conversationId branch
-> calls /commerce/message/v1/conversation/124850576707 directly
-> detail response includes 25 messages
-> upsertMessages inserts 3 new rows
-> updateConversationFromDetail advances latest to Testing 5
```

This is a selection divergence before detail sync, not a message persistence divergence after detail sync.

## Required Questions

### Q1

Can Sync Recent Mailbox discover brand new conversations and new messages inside existing conversations?

Answer:

```text
Yes, but only for conversations returned by the bounded latest conversation-list phase.
```

Evidence:

- Run `4003a547-710a-43fc-9514-3b851089362f` inserted 15 conversations and 18 messages.
- The same run updated 2 existing conversations.
- The same run did not update `124850576707` because that conversation was absent from the returned conversation IDs.

So Sync Recent is not "only brand new conversations", but it is also not a complete existing-conversation refresh.

### Q2

When a new member message appears in an already-known conversation, what path is supposed to refresh latest fields, preview, and timeline messages?

Expected path when the conversation is selected by Sync Recent:

```text
conversation list returns existing conversation
-> processConversationPage(...)
-> upsertConversation(...)
-> syncConversationDetail(...)
-> upsertMessages(...)
-> updateConversationFromDetail(...)
-> fetchEbayConversations(...) / mailbox RPC
-> fetchEbayConversationMessages(...) for selected timeline
```

Fields refreshed by `updateConversationFromDetail(...)`:

```text
latest_message_id
latest_message_created_at
latest_message_preview
first_message_created_at
last_message_created_at
message_count
last_detail_synced_at
last_synced_at
```

The path works when invoked. Refresh Timeline proved it by advancing `rafa1-6` from `Testing 2` to `Testing 5`.

### Q3

Step-by-step comparison:

| Area | Sync Recent Mailbox | Refresh Timeline |
| --- | --- | --- |
| Frontend entry | `syncLatestEbayConversations` | `refreshEbayConversationTimeline` |
| Edge Function | `ebay-message-sync` | `ebay-message-sync` |
| Run type | `incremental` | `manual` |
| Conversation id | none | selected eBay conversation id |
| Conversation types | `FROM_MEMBERS`, `FROM_EBAY` | selected type when known |
| List endpoint | yes | no |
| Detail endpoint | only for listed conversations | direct target conversation |
| Conversation page limit | 25 | 1, but ignored by targeted branch |
| Message page limit | 25 | 50 |
| Max conversation pages | 1 | parsed to 0 because `conversationId` exists |
| Max detail pages | 20 | 20 |
| Checkpoint | `commerce_message_latest_sync` | none for manual targeted run |
| `FROM_MEMBERS` filter | `start_time` from latest checkpoint or 14-day lookback | none |
| `FROM_EBAY` filter | first latest page, then post-filtered by cutoff | none |
| Mailbox reload | reloads page 1 / current list query | reloads selected messages, drafts, and page 1 |

### Q4

Which failure mode does Rafa indicate?

Answer:

```text
A. provider never returned the conversation to Sync Recent's list path.
```

Rejected alternatives:

- B, provider returned conversation but not messages: no. Sync Recent run metadata did not include `124850576707`.
- C, detail sync skipped: only as a consequence of list omission. There was no detail attempt for `124850576707` in Sync Recent.
- D, checkpoint excluded it: not as the immediate cause in the validated run. The pre-run checkpoint was `2026-06-06T23:39:23+00:00`, earlier than `Testing 3 / 4 / 5`. However, the new checkpoint advanced to `2026-06-07T15:25:12+00:00`, so future Sync Recent runs would now be even less likely to revisit these missed 02:42-03:52 messages.
- E, timeline persistence bug: no. Targeted refresh inserted the missing rows and advanced latest fields.
- F, UI rendering bug: no. After targeted refresh, UI and canonical state showed `Testing 5`.

### Q5

Playwright/browser validation evidence:

```text
Sync Recent run: 4003a547-710a-43fc-9514-3b851089362f
Refresh Timeline run: 141c64ae-fd16-4000-ba31-143c6644aea9
Target: b2659307-4dc3-4708-9b46-3735679a5398 / 124850576707
Send/eBay mutation guard: blocked send attempts 0
```

Result:

```text
Sync Recent changed other mailbox data but left rafa1-6 at Testing 2 / 22 messages.
Refresh Timeline immediately inserted Testing 3, Testing 4, Testing 5 and advanced rafa1-6 to Testing 5 / 25 messages.
```

## Severity

Severity: High.

Reason:

Existing member conversations can contain new buyer messages that the operator expects "Sync Recent Mailbox" to surface, but the current workflow can miss them indefinitely unless the operator manually opens the conversation and clicks Refresh Timeline or another archive/detail path eventually reaches it.

This is an operator-trust issue, not a data-loss issue. The provider detail endpoint still has the messages and the canonical persistence path works.

## Recommended Fix

Do not rely on the provider conversation-list endpoint as the only source of existing-conversation deltas.

Recommended implementation:

1. Keep the current provider latest-list phase for brand new conversations and conversations the provider does return.
2. Add a bounded canonical detail-refresh sweep to Sync Recent for existing `FROM_MEMBERS` conversations that are likely stale.
3. Seed that sweep from canonical storage, not from the provider list. Candidate examples:
   - current top N `FROM_MEMBERS` conversations by `latest_message_created_at`
   - conversations with `last_detail_synced_at` older than a threshold
   - conversations visible in the current mailbox page
   - conversations with recent classifications/drafts whose latest detail sync is stale
4. Reuse the existing `syncConversationDetail(...)`, `upsertMessages(...)`, and `updateConversationFromDetail(...)` path.
5. Add explicit counters such as `canonicalDetailSweepCandidates`, `canonicalDetailSweepRefreshed`, and `canonicalDetailSweepMessagesInserted`.
6. Update the harness to target a known existing conversation and assert that Sync Recent can refresh new detail messages without requiring manual Refresh Timeline.

Checkpoint caution:

The current latest checkpoint can advance past missed detail messages because it is based on conversations actually returned by the list endpoint. The fix should not allow "checkpoint succeeded" to imply "all recent existing conversation details are current" unless the canonical detail sweep also completes.

## Whether Fix Requires

| Area | Required? | Notes |
| --- | --- | --- |
| Migration | No for the minimum fix | Existing tables already contain conversation ids, latest fields, detail sync timestamps, run metadata, and messages. A migration is optional only if first-class sweep counters/columns are desired. |
| Edge Function | Yes | `ebay-message-sync` must refresh a bounded canonical set of existing conversations independent of the provider list result. |
| Frontend | Optional but recommended | Data correctness can be fixed in the Edge Function. Frontend copy should clarify that Sync Recent is a bounded latest sync, and result copy should show list-refresh versus canonical-detail-sweep counts. |

## Beta Impact

Beta readiness impact: material negative until fixed.

The reclassify terminalization issue is closed, but inbox trust is still not beta-safe for existing member conversations. A buyer can send a new message in a known thread, eBay can show it, and Sync Recent can report success while canonical storage and the mailbox remain stale for that thread.

Updated beta readiness estimate after this audit: 74%.

Reason:

- Operator-truth improvements from 5F.6S.4A still stand.
- This audit proves a real remaining sync correctness gap for existing member conversations.
- The persistence path is healthy, so the fix is narrow: Edge Function sync selection/sweep logic rather than schema or UI rewrite.

## Final Answer

Why does Sync Recent Mailbox fail to show `Testing 3 / Testing 4 / Testing 5` while Refresh Timeline can discover newer conversation state?

```text
Because Sync Recent Mailbox only detail-syncs conversations returned by its bounded
provider conversation-list call. In the validated run, that list did not include
rafa1-6 / 124850576707, so detail sync never ran for that conversation.

Refresh Timeline targets 124850576707 directly, bypasses the list/checkpoint phase,
fetches conversation detail, persists the three missing messages, and updates the
canonical latest fields to Testing 5.
```

No further assumption is needed; the run metadata, checkpoint state, canonical before/after rows, and Playwright validation all agree.
