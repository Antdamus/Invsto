# Step 5F.6P.2 - Event Mirror Validation + Username/Context Consistency Audit

Date: 2026-06-08

## Executive Summary

Pass.

OG is now mirroring eBay Messages through the event/webhook path for both `FROM_MEMBERS` and `FROM_EBAY` conversations. Live database evidence shows `NEW_MESSAGE` notification ledger rows for both types, verified signatures, targeted sync runs, canonical message/conversation updates, and dashboard activity events. Manual `Sync Recent` and `Refresh Timeline` are not required for the observed webhook-mirrored inbox items; they remain fallback and validation tools.

The main product bug found in this step was the conversation-list identity fallback. Some canonical mailbox rows had blank `other_party_username` and no linked buyer/order context, while the opened timeline had sender usernames such as `conghung081870`, `kemor_48`, and `gomit-42`. The canonical RPC did not return participant usernames, and the frontend did not enrich the row from loaded timeline messages, so list cards could show `Unknown buyer`.

Fixes made:

- `email-triage.api.js` now preserves RPC-provided `summary.participant_usernames` and `summary.message_buyer_username`.
- `email-triage.js` now enriches a selected member conversation's missing identity from loaded message sender/recipient usernames, excluding the seller account and platform `eBay`.
- Added migration `20260608133000_ebay_canonical_mailbox_participant_identity.sql` so `get_ebay_canonical_mailbox_v2` returns message-derived participant identity on first mailbox load after deployment.
- Hardened the Playwright live-sync harness to accept durable sync-run recovery when the browser-side Edge Function response times out but the UI/dashboard reconcile a successful run.

## Pass / Fail

Overall: PASS

Event mirror: PASS

Username display: PASS after frontend deploy; full first-load coverage also requires the new RPC migration.

Buyer / Order Context: PASS as expected missing data for audited empty panels; no deterministic context-linking bug found.

Regression safety: PASS. Baseline and guarded live Playwright validations passed. No send attempts were blocked or made by the tests, and sync responses reported `messagesSent: 0`.

## Event Mirror Evidence

Evidence artifacts:

- `tests/email-triage/reports/step-5f6p2-db-audit.json`
- `tests/email-triage/reports/step-5f6p2-live-sync-timeout-durable-check.json`
- `tests/email-triage/reports/email-triage-regression-2026-06-08T18-04-28-287Z.md`

Notification ledger sample:

```text
total sampled: 30
topic: NEW_MESSAGE = 30
conversationType: FROM_EBAY = 15
conversationType: FROM_MEMBERS = 15
signature_verified = 27
processing_status:
  sync_succeeded = 25
  sync_failed = 2
  signature_failed = 3
```

The 3 `signature_failed` rows were synthetic Codex probes with `missing_x_ebay_signature`. The 2 `sync_failed` rows were earlier `FROM_MEMBERS` retries for conversation `9394020427474` with `targeted_sync_failed:502:ebay_api_get_failed`. The current verified `FROM_EBAY` evidence rows succeeded.

Representative `FROM_EBAY` rows:

```text
topic: NEW_MESSAGE
conversationType: FROM_EBAY
notification_id: 587e72d1-ca31-459c-961b-91e2c8be5dc4_fc27b20a-7042-4497-ad45-9b5c85825cca
signature_verified: true
processing_status: sync_succeeded
sync_run_id: c01e83fb-ceca-4626-a141-83fdc8ea3e28
ebay_conversation_id: 208023427229
ebay_message_id: 208023427229
messagesInserted: 0
messagesUpdated: 0
messagesRechecked: 1
dashboard event status: provider_notification_received / succeeded
```

```text
topic: NEW_MESSAGE
conversationType: FROM_EBAY
notification_id: 47afc1f5-622a-4631-93c3-87c56493af2b_2c2159be-7164-4aff-8108-a4de6a37376b
signature_verified: true
processing_status: sync_succeeded
sync_run_id: 293066aa-964b-4cf6-bb63-c5f239c6e447
ebay_conversation_id: 208023424449
ebay_message_id: 208023424449
messagesInserted: 0
messagesUpdated: 0
messagesRechecked: 1
dashboard event status: provider_notification_received / succeeded
```

Representative `FROM_MEMBERS` row:

```text
topic: NEW_MESSAGE
conversationType: FROM_MEMBERS
notification_id: b5e50f43-4e2d-4fd9-8f6a-c09d79407f43_7b00742c-8bee-4bb5-a2dd-7c581281e22f
signature_verified: true
processing_status: sync_succeeded
sync_run_id: e5c2f49f-6703-4a4f-89e1-a81a609c8e1f
ebay_conversation_id: 125186162411
ebay_message_id: 6258855623019
messagesInserted: 0
messagesUpdated: 0
messagesRechecked: 1
dashboard event status: provider_notification_received / succeeded
```

Refund/return/case examples in canonical storage:

```text
208023427229 - FROM_EBAY - Return 5320534430: Item delivered
208023424449 - FROM_EBAY - Return 5320607792: Item delivered
208022561979 - FROM_EBAY - New outcome for case 5379955386
208022113359 - FROM_EBAY - You successfully canceled an order
208019291039 - FROM_EBAY - A buyer wants to cancel an order
```

Event path answers:

1. Did `FROM_EBAY` notifications arrive through webhook/event path? Yes.
2. Did they create `ebay_message_notifications` rows? Yes.
3. Did they trigger targeted sync runs? Yes, successful rows have `sync_run_id`.
4. Did targeted sync update canonical conversations/messages? Yes. Successful targeted rows returned the target `conversationIds`, `messagesSeen`, and insert/update/recheck counters.
5. Did OG mailbox counts update after refresh? Yes. Canonical count moved from 504 to 506 during live validation, with `members: 304` and `ebay_notifications: 202` in the final report.
6. Were `Sync Recent` or `Refresh Timeline` required? No for the webhook-mirrored items. They were run as validation/fallback checks only.
7. Are `FROM_EBAY` eBay inbox items covered by `NEW_MESSAGE`? Yes. All sampled `FROM_EBAY` rows had `topic = NEW_MESSAGE`.
8. Are refund/return/case notices coming in as `conversationType = FROM_EBAY`? Yes, when they appear in the eBay Messages inbox.

## Username Display Finding

Finding: bug, fixed.

Root cause:

- The live canonical RPC response for affected member rows contained link counts and message counts, but not participant usernames.
- `other_party_username` was blank on affected conversations.
- Message rows did contain usernames, for example `sender_username = conghung081870`.
- The list card identity fallback only used `buyer_identity`, linked buyer context, or `other_party_username`, so it could display `Unknown buyer`.
- The opened timeline displayed the sender username because message rows were loaded separately.

Examples before fix:

```text
125186162411 - FROM_MEMBERS
other_party_username: blank
message_usernames: conghung081870, ogjewelers
link_count: 0
list card risk: Unknown buyer
```

```text
125182412507 - FROM_MEMBERS
other_party_username: blank
message_usernames: kemor_48, ogjewelers
link_count: 0
list card risk: Unknown buyer
```

Fix:

- Frontend fallback now enriches a selected member row from loaded timeline messages.
- Seller username and platform `eBay` are excluded from member buyer identity fallback.
- RPC normalizer now preserves future RPC `participant_usernames` and `message_buyer_username`.
- New migration adds those summary fields directly to `get_ebay_canonical_mailbox_v2`.

Post-fix UI proof:

Artifact: `tests/email-triage/reports/step-5f6p2-username-ui-probe.json`

```text
target: 125186162411
summary: Matching: 1
row text includes: conghung081870
rowHasUnknownBuyer: false
detailHasConghung: true
```

`FROM_EBAY` behavior:

- Platform notification rows should continue to identify the sender/source as `eBay` rather than `Unknown buyer`.
- If a return/order/case link identifies the buyer, that buyer appears through linked context and row metadata, not as a false sender.
- If a platform notice has only `eBay` and seller participants and no linked buyer/order, it should not invent a buyer.

## Buyer / Order Context Finding

Finding: expected missing data for audited empty panels; no deterministic context-linking/rendering bug found.

Evidence artifacts:

- `tests/email-triage/reports/step-5f6p2-db-audit.json`
- `tests/email-triage/reports/step-5f6p2-context-linkability.json`

The UI fetches `ebay-conversation-context` with:

```text
mode: context
```

That mode reads existing deterministic links. It does not run the deterministic linker when a user merely opens a conversation.

Audited empty-context examples:

```text
125186162411 - FROM_MEMBERS
available_usernames: conghung081870, ogjewelers
link_count: 0
hard identifiers: no order numbers, no transaction ids, no return ids
weak/non-order hints: #812, 125186162411
exact custom_label matches: none
finding: no safe deterministic link
```

```text
125182412507 - FROM_MEMBERS
available_usernames: kemor_48, ogjewelers
link_count: 0
hard identifiers: no order numbers, no transaction ids, no return ids
exact custom_label matches: none
finding: no safe deterministic link
```

```text
125805711404 - FROM_MEMBERS
available_usernames: gomit-42, ogjewelers
link_count: 0
hard identifiers: no order numbers, no transaction ids, no return ids
exact custom_label matches: none
finding: no safe deterministic link
```

Conclusion:

- Empty Buyer / Order Context is expected when there are no active links and the message has only a username or prose.
- Buyer username alone is not enough to attach an order safely.
- No frontend rendering bug was found for returned context.
- No deterministic linker repair was applied because the audited examples did not contain safe exact identifiers.

Recommended follow-up, not a blocker:

- Add a small operator-only "sender context" hint for no-link conversations, separate from confirmed Buyer / Order Context.
- Consider a manually reviewed "suggest possible buyer history by username" action, but keep it out of buyer-facing draft grounding unless confirmed.

## Regression Safety

Commands run:

```sh
node --check email-triage.js
node --check email-triage.api.js
node --check tests/email-triage/email-triage-regression.spec.mjs
npm run test:email-triage
EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true npm run test:email-triage
```

Baseline Playwright:

```text
report: tests/email-triage/reports/email-triage-regression-2026-06-08T17-53-36-561Z.md
result: 2 passed
blocked send attempts: 0
```

Live sync/refresh Playwright:

```text
report: tests/email-triage/reports/email-triage-regression-2026-06-08T18-04-28-287Z.md
result: 2 passed
blocked send attempts: 0
```

Sync Recent validation:

```text
runId: 06f2eee5-95fa-4e88-a908-a2876eeaab0f
runType: incremental
checkpointScope: commerce_message_latest_sync
conversationTypes: FROM_MEMBERS, FROM_EBAY
conversationsSeen: 101
conversationsInserted: 0
conversationsUpdated: 0
messagesSeen: 577
messagesInserted: 0
messagesUpdated: 0
messagesRechecked: 577
canonicalDetailSweepCandidates: 100
canonicalDetailSweepRefreshed: 100
canonicalDetailSweepMessagesRechecked: 576
messagesSent: 0
sendsEnabled: false
ebayMutationsPerformed: false
```

Refresh Timeline validation:

```text
runId: cf864290-69c6-4717-ab42-637d6a4c92e3
runType: manual
conversationId: 125151481207
conversationsSeen: 1
messagesSeen: 5
messagesInserted: 0
messagesUpdated: 0
messagesRechecked: 5
messagesSent: 0
sendsEnabled: false
ebayMutationsPerformed: false
```

No unintended eBay mutations:

```text
Blocked send attempts: 0
messagesSent: 0
sendsEnabled: false
ebayMutationsPerformed: false
Provider read-state update: skipped unless explicit confirmation env is set
```

Note: an earlier live run timed out waiting for the browser-visible sync response, but durable run evidence showed the sync succeeded. The harness now recovers from that normal long-running UI path by checking durable sync runs.

## Deployment Requirements

Migration required? Yes.

- Apply `supabase/migrations/20260608133000_ebay_canonical_mailbox_participant_identity.sql`.
- This replaces `get_ebay_canonical_mailbox_v2` with the same signature and adds read-only summary fields for participant identity.

Edge Function deploy required? No.

- No Edge Function code changed.

Frontend deploy required? Yes.

- Deploy `email-triage.api.js`, `email-triage.js`, and the updated regression harness if test assets are deployed/used in CI.

New secrets required? No.

eBay config required? No.

- `NEW_MESSAGE` is already covering `FROM_MEMBERS` and `FROM_EBAY` items that appear in the eBay Messages inbox.
- Future non-inbox eBay events may still require separate topic subscriptions, but that is not required for the validated refund/return/case notices in this step.

## Beta Readiness

Updated beta readiness estimate:

```text
97%
```

Reason:

- Event-driven eBay mailbox mirroring is proven for member messages and eBay platform notifications in Messages.
- Controlled send safety remained intact.
- The main operator-trust display issue found in this step is fixed.
- Empty context panels were audited and found expected for the sampled no-link rows.

Remaining beta caveats:

- Deploy the RPC migration and frontend static assets before relying on first-load username fallback in production.
- Keep `Sync Recent` as a fallback reconciliation action.
- Continue monitoring occasional provider API sync failures, but the current `FROM_EBAY` notification mirror evidence is strong.

## Final Decision

Yes, move to:

```text
5F.6M - Controlled Return Messaging
```

No additional sync/context stabilization step is required before 5F.6M, provided the username display repair is deployed with the new RPC migration. Controlled Return Messaging should still preserve the current guardrails: human-controlled send only, no automatic responses, send-attempt idempotency, and explicit no-mutation regression checks.
