# Step 4D Draft Generation Stabilization Audit

## Executive Summary

This was an audit-only review. No runtime behavior, schema, migrations, deployments, or production data were changed.

The eBay/order matcher itself is not the primary breakage point. The matcher in `supabase/functions/microsoft-email-process/index.ts` is deterministic, regex/query based, and conservative. The instability was introduced mostly in the draft generation/fallback/persistence/UI layer after order context was connected.

The system now has too many draft outcomes that can all become "current": valid AI drafts, valid fallback drafts, invalid AI drafts, malformed/error drafts, and caught fallback failures. `insertResponseDraft()` supersedes the previous current draft before inserting the new one, including invalid/error outcomes. As a result, a failed attempt can hide a previously usable draft and make `admin_draft_view` and `operator_match_context` report a new current error state.

The second major issue is selector drift. `admin_draft_view` filters by `message_id` when both `messageId` and `classificationId` are provided, while regenerate/review paths validate both `draftId` and `classificationId`. The UI sends both selected classification ID and current draft ID. If the current draft belongs to a prior classification, regenerate/review can fail with `response_draft_classification_mismatch` even though a draft exists for the message.

The third major issue is fallback validation. Fallback is deterministic, but it is still passed through the broad AI draft validator. That validator checks unsupported factual claims, category matching, tracking-like tokens, product types, shipping phrases, refund wording, and timelines. The special safe-fallback relaxation only applies to a narrow "generic" shape and is sensitive to exact wording such as a bare `Hi,` greeting. This makes safe fallback capable of failing validation, after which the catch block saves an error draft as current.

Recommended target architecture: deterministic extraction/matching, a verified context builder, AI drafting from buyer-stated text plus confirmed facts, strict validation for AI factual claims, deterministic fallback only after invalid AI, fallback checked only for forbidden specific claims, exactly one current successful draft outcome per generation action, and one canonical current draft reader for the UI.

## Current Architecture Map

Flow today:

```text
Outlook / Microsoft Graph
-> microsoft-email-sync
-> email_messages + email_message_bodies + email_message_recipients
-> microsoft-email-process normalize/match_order
-> email_message_links
-> microsoft-email-classify classify
-> email_message_classifications
-> microsoft-email-classify admin_context_view
-> buildVerifiedOrderContext()
-> generate_response / regenerate_response
-> OpenAI response draft
-> validateResponseDraft()
-> optional buildSafeFallbackDraft()
-> validateSafeFallbackDraft()
-> email_response_drafts
-> admin_draft_view / operator_match_context
-> email-triage.js rendering
```

Key files:

- `supabase/functions/microsoft-email-sync/index.ts`: Outlook sync and persistence.
- `supabase/functions/microsoft-email-process/index.ts`: normalization and deterministic matching.
- `supabase/functions/microsoft-email-classify/index.ts`: classification, context views, draft generation, validation, fallback, draft persistence, review transitions.
- `email-triage.js`: admin UI state, draft/match fetches, render logic, draft/review actions.
- `supabase/migrations/20260520143000_email_triage_persistence_foundation.sql`: email persistence, processing jobs, links.
- `supabase/migrations/20260520193000_email_triage_classification_schema_foundation.sql`: classification columns.
- `supabase/migrations/20260522120000_email_triage_response_draft_persistence.sql`: response draft table.

## Email Ingestion Flow

Outlook data is fetched by `supabase/functions/microsoft-email-sync/index.ts`.

The sync function uses Microsoft Graph delta queries against the active Microsoft mailbox. It requests message metadata, body, sender/from recipients, recipients, and message IDs. It sends `Prefer: IdType="ImmutableId"` when fetching from Graph.

Persisted tables:

- `email_mailboxes`: provider mailbox record and Microsoft connection reference.
- `email_folders`: provider folder IDs such as Inbox.
- `email_sync_states`: delta link/checkpoint and sync state.
- `email_sync_runs`: audit of each sync run.
- `email_messages`: durable message metadata:
  - `provider_message_id`
  - `provider_immutable_id`
  - `internet_message_id`
  - `conversation_id`
  - `conversation_index`
  - `subject`
  - `subject_normalized`
  - `from_name`, `from_email`
  - `sender_name`, `sender_email`
  - `reply_to_emails`
  - `received_at`, `sent_at`
  - `body_preview`
  - Graph etag/change key/status metadata
- `email_message_recipients`: normalized from/sender/to/cc/bcc/reply-to rows.
- `email_message_bodies`: body storage:
  - `body_text`
  - `body_html`
  - `normalized_text`
  - hashes
  - `redaction_status`
  - metadata

Message IDs:

- Internal system ID is `email_messages.id` UUID.
- Microsoft Graph ID is stored as `provider_message_id`.
- Because sync requests immutable IDs, the same Graph ID is also stored in `provider_immutable_id`.
- `internet_message_id` is stored as fallback identity and is used by sync to find an existing message if the provider ID lookup misses.

## Classification Flow

Classification is implemented in `supabase/functions/microsoft-email-classify/index.ts`.

Modes include:

- `enqueue_only`
- `process_queued`
- `enqueue_and_process`
- `process_message`
- `dry_run`
- `replay_classification`
- `admin_view`
- `message_detail`
- `save_review`
- draft and context modes listed later

Classification jobs use `email_processing_jobs.job_type = 'classify'`. The function builds a structured `ClassifierInput` from `email_messages`, `email_message_bodies`, `email_message_recipients`, and compact `email_message_links`.

OpenAI is used for classification through `callOpenAI()`, using:

- model env: `OPENAI_EMAIL_CLASSIFIER_MODEL`
- prompt env: `EMAIL_CLASSIFIER_PROMPT_VERSION`
- prompt builder: `buildPrompt()`
- Responses API endpoint: `https://api.openai.com/v1/responses`
- strict JSON schema: `jsonSchema()`

The output is structured JSON with category, priority, urgency, workflow urgency/priority, response timing, risks, summary, recommended action, detected entities, reasoning summary, and safety flags.

Classifications are stored in `email_message_classifications`. Important columns include:

- `message_id`
- `source`
- `classifier_name`
- `classifier_version`
- `category`, `subcategory`
- `confidence`
- `priority`, `urgency`
- `priority_level`, `urgency_level`
- `response_timing`
- `customer_risk`
- `refund_risk`, `chargeback_risk`
- `response_needed`
- `summary`, `reasoning_summary`
- `recommended_action`
- `detected_entities`
- `safety_flags`
- `validation_status`
- `validation_errors`
- `raw_safe_output`
- `input_hash`
- `is_current`
- review override fields

When a valid classification is inserted, previous current AI classifications for the message are superseded. Invalid classifications are inserted with `is_current = false`.

## eBay Matching Flow

Matching code lives in `supabase/functions/microsoft-email-process/index.ts`.

Matching is triggered by the `match_order` job type in modes:

- `enqueue_only`
- `process_queued`
- `enqueue_and_process`
- `process_message`

The matcher loads:

- `email_messages`
- `email_message_bodies`
- `email_message_recipients`

It builds search text from:

- subject
- body preview
- normalized body text
- from/sender names and emails
- recipient display names and emails

Identifier extraction is deterministic and regex/programmatic:

- eBay order numbers: `\b\d{2}-\d{5}-\d{5}\b`
- item numbers: 12 digit tokens
- transaction IDs: 14 digit tokens
- return IDs: return/return case/eBay return ID label patterns
- tracking numbers: labeled tracking/shipping barcode/label ID patterns
- buyer usernames: eBay subject pattern like "`<username> sent a message`" and sender/from names
- buyer emails: participant emails and email regex, excluding masked/eBay/no-reply patterns for usable buyer email matching
- custom labels like `#484`: `#\d+\b`, plus custom label/SKU/label labeled values
- title phrases: labeled item/listing/title phrases and subject phrases

Database lookups are deterministic:

- order number exact -> `ebay_orders.order_number`
- return ID exact -> `ebay_return_cases.ebay_return_id`
- tracking exact -> `ebay_orders.tracking_number` and safe label metadata keys
- item + transaction exact -> `ebay_order_lines.item_number` + `transaction_id`
- item number exact -> unique `ebay_order_lines.item_number`
- buyer username/email only with additional context, or unique username alone at low confidence
- custom label exact -> `ebay_order_lines.custom_label`
- inventory label exact -> `item_types.barcode` / `qr_code`
- title contains matches only when unique

AI is not used for matching. The matcher does not call OpenAI and does not allow AI to invent identifiers.

Match methods and rough strength:

- Strong confirmed:
  - `order_number_exact`, confidence 1.0, `confirmed`
  - `return_id_exact`, confidence 1.0, `confirmed`
  - `item_transaction_exact`, confidence 1.0, `confirmed`
  - `tracking_or_label_exact`, confidence 0.9, `confirmed`
- Suggested/weak:
  - `item_number_exact`, confidence 0.8, `suggested`
  - `internal_label_custom_label_exact`, confidence 0.78, `suggested`
  - `buyer_username_plus_strong_clue`, confidence 0.65, `suggested`
  - `buyer_email_plus_strong_clue`, confidence 0.65, `suggested`
  - `buyer_username_alone_unique`, confidence 0.45, `suggested`
  - `internal_label_inventory_exact`, title contains, and title phrase contains, confidence 0.5-0.55, `suggested`

## Verified Context Flow

Read-only context is built in `microsoft-email-classify/index.ts`.

`admin_context_view`:

- Loads links from `email_message_links`.
- For normal admin context, includes only `suggested` and `confirmed`.
- For `operator_match_context`, includes all link statuses.
- Reads eBay/order tables to assemble operator context.
- Does not mutate eBay/order tables.

Tables read:

- `ebay_orders`
- `ebay_order_lines`
- `item_types`
- `ebay_return_cases`
- `ebay_return_items`
- `ebay_order_tasks`
- `ebay_return_tasks`
- `ebay_return_messages`
- `email_message_links`

`operator_match_context` calls `admin_context_view`, reshapes matches for the UI, and adds latest validation state from the current response draft or current classification.

`buildVerifiedOrderContext()` converts the broader admin context into buyer-facing verified context. It uses `buyerFacingVerifiedLinkScope()`:

- Only `confirmed` links are eligible.
- Weak methods are excluded even if present.
- Weak/suggested links set `weak_match_treated_as_unverified = true`.
- If no buyer-facing verified link remains, `buyer_facing_context_level = 'generic'`.

`verified_order_context` contains:

- `known.order`
- `known.order_lines`
- `known.shipping`
- `known.return_case`
- `known.tasks`
- `unknown`
- `do_not_claim`
- `summary`

Meaning:

- `known`: facts safe for buyer-facing use because they came from confirmed, non-weak links.
- `unknown`: facts missing or not verified, such as tracking not found or weak match treated as unverified.
- `do_not_claim`: explicit negative rules for the AI and validator.

The builder mostly separates buyer-facing verified database facts from operator context. Buyer-stated claims are not a separate structured field; they remain in the email body/subject/classification text. This is usable, but it forces prompt and validation logic to distinguish "buyer stated" from "DB verified" from raw strings instead of typed fields.

## AI Draft Generation Flow

`generate_response` and `regenerate_response` are both implemented by `generateResponseDraft()` in `microsoft-email-classify/index.ts`.

`regenerate_response` passes the same path with `operationMode = 'regenerate_response'`.

Input loading:

- `loadResponseDraftInput()` resolves message/classification/draft selectors.
- It requires a valid AI classification (`validation_status = 'valid'`).
- It loads classifier input again.
- It builds effective classification with operator overrides.
- It calls `admin_context_view`.
- It builds `verified_order_context`.

OpenAI draft call:

- Function: `callOpenAIResponseDraft()`
- Endpoint: Responses API
- Model env: `OPENAI_EMAIL_RESPONSE_DRAFT_MODEL`, falling back to `OPENAI_EMAIL_CLASSIFIER_MODEL`
- Prompt version env: `EMAIL_RESPONSE_DRAFT_PROMPT_VERSION`, default `step-4d.6-v1`
- Prompt builder: `buildResponseDraftPrompt()`
- Schema: `responseDraftJsonSchema()`
- Input sent as structured JSON via `stableStringify(draftInput)`

The prompt correctly states the desired rule:

```text
AI may personalize from buyer-stated email content.
AI may use verified DB facts only when confirmed.
AI must not turn buyer claims into verified facts.
```

However, buyer-stated claims are only implicit in body/subject/summary. There is no structured `buyer_stated_claims` field, which makes validation harder and leads to false positives or conservative fallback.

## Validation Flow

Draft validation lives in `validateResponseDraft()`.

Validation is rule/regex based, not AI based. It checks:

- required schema fields
- category equals effective category
- subject/body present and length bounds
- `requires_human_review = true`
- safety flags are allowed
- refund promises
- compensation promises
- legal admissions
- unsafe escalation language
- fabricated shipping updates
- fabricated timelines
- fabricated inventory/replacement promises
- tracking-like tokens not grounded in verified context
- order/item number claims not grounded in verified context
- unsupported return approval
- unsupported refund state
- fabricated or unsupported item type claims
- high-caution certainty wording

Validation uses:

- `verifiedGrounding`: stringified `verified_order_context.known`
- `buyerStatedGrounding`: subject, preview/body, summary, reasoning summary

Fallback uses the same validator through `validateSafeFallbackDraft()`, with `profile: 'safe_fallback'`.

The fallback profile only relaxes errors when `isAllowedGenericFallbackDraft()` returns true. That function is narrow:

- requires body to start with `Hi,`
- requires exact generic concepts: `your message`, `your concern`, `available information`, `relevant details`
- requires signature
- rejects phrases like `your order`, `your item`, `your shipment`, `your package`, `your refund`, specific numbers, shipping state, refund approval, replacement availability, and timelines

This can incorrectly reject generic or safe fallback text because fallback templates often:

- use `Hi <name>,` via `safeBuyerGreeting()`
- specialize by concern type (`shipment concern`, `item concern`, `cancellation concern`)
- include benign operational phrases that the broad validator still examines

Important finding: even when fallback validation fails, the thrown `safe_fallback_validation_failed` is caught by the broad `catch` inside `generateResponseDraft()`. The catch inserts an error draft as current.

## Fallback Flow

There is one main deterministic fallback builder: `buildSafeFallbackDraft()`.

Fallback happens after the AI draft is generated and fails validation, but only when `shouldGenerateFallbackDraft()` sees unsupported-claim style errors.

Fallback is deterministic template text. It is not AI-generated.

Fallback concern type is determined by classification/category and keyword search:

- `cancellation`
- `return_refund`
- `shipping`
- `item`
- `general`

When fallback works:

- fallback draft is inserted with `validation_status = 'valid'`
- metadata includes:
  - `fallback_used = true`
  - `fallback_reason = 'primary_draft_failed_validation'`
  - `fallback_type`
  - `primary_validation_status = 'invalid'`
  - `primary_validation_errors`
  - `original_draft_blocked = true`
  - `fallback_body_saved = true`
- response returns `draft_subject` and `draft_body_text`

When fallback fails:

- `safe_fallback_validation_failed` is thrown.
- The surrounding catch catches it.
- `insertResponseDraft()` is called with `validationStatus = 'error'`, `validationErrors = ['safe_fallback_validation_failed']`, no draft body.
- The error draft is inserted as `is_current = true`.
- The previous current draft is superseded.
- The API still returns `ok: true` with an error validation state.

This is a core instability source. Fallback can fail validation, and that failure can save a body-less error draft as current, hiding older usable content.

Fallback also became over-generic because it only selects one of five coarse concern templates. It does not extract a short buyer-stated issue phrase beyond broad category/keyword selection. The AI prompt supports personalization, but once fallback becomes the dominant path, rich personalization is lost.

## Draft Persistence Flow

Drafts are stored in `email_response_drafts`.

Important columns:

- `message_id`
- `classification_id`
- `source`: `ai`, `human`, `template`, `rule`
- `draft_status`: `generated`, `reviewing`, `approved`, `rejected`, `superseded`, `archived`
- `draft_subject`
- `draft_body_text`
- `draft_body_format`
- `model_name`
- `prompt_version`
- `prompt_hash`
- `input_hash`
- `draft_version`
- `is_current`
- `superseded_at`
- `validation_status`: `not_validated`, `valid`, `invalid`, `warning`, `error`
- `validation_errors`
- `safety_flags`
- `requires_human_review`
- approval/rejection/operator fields
- `metadata`

Versioning:

- `nextDraftVersion()` selects max `draft_version` for a message and adds 1.
- `insertResponseDraft()` supersedes all current drafts for the message, then inserts the new row as current.
- `saveDraftReview()` also supersedes current rows and inserts a human reviewed version.

Invalid/error current risk:

- `insertResponseDraft()` does not distinguish successful usable outcomes from invalid/error outcomes.
- Invalid AI drafts can become current.
- OpenAI errors can become current.
- `safe_fallback_validation_failed` can become current.
- A current error row with null body makes `admin_draft_view` omit draft body, so the UI may show an empty editor or blocked/omitted state.

Fallback metadata:

- `fallback_used`
- `fallback_reason`
- `fallback_type`
- `fallback_body_saved`
- `primary_validation_status`
- `primary_validation_errors`
- `primary_validation_error_explanations`

There is no physical `fallback_body_saved` or `draft_content_returned` column; these are metadata/response-derived fields.

## UI Rendering Flow

The admin UI is `email-triage.js`.

Draft loading:

- `fetchDraftView()` calls `microsoft-email-classify` mode `admin_draft_view`.
- It sends `messageId`, `classificationId`, `includeDraftBody: true`, `limit: 20`.

Backend `adminDraftView()` behavior:

- If `draftId` is provided, filters by draft ID.
- Else if `messageId` is provided, filters by message ID.
- Else if `classificationId` is provided, filters by classification ID.
- When both message and classification are provided, classification is ignored.
- It orders by `is_current desc`, `draft_version desc`, `created_at desc`.

This means a UI request for selected classification X can receive current draft Y for the same message but a different classification.

Body return:

- `safeDraftSummary()` returns body only if `includeDraftBody` is true and `draftContentIsSafe()` returns true.
- `draftContentIsSafe()` returns false unless `validation_status = 'valid'`.
- It returns true for valid fallback rows with `metadata.fallback_used = true` and `metadata.fallback_body_saved = true`.
- Otherwise it blocks rows with safety flags in `DRAFT_CONTENT_BLOCKING_FLAGS`.

UI current draft selection:

- `currentDraftFromPayload()` picks the row with `is_current === true`, else first row.
- Render logic enables editing when `draft_content_returned = true`, or when fallback body exists.
- It shows blocked-content warnings when content is not safe/returned.
- It shows fallback notices when fallback metadata is present.
- It shows action errors from `draftActionErrorsByMessageId`.

Stale error risk:

- `runDraftAction()` clears action error at start and success, then reloads draft/match context.
- `loadDraftView()` also clears action errors after successful draft fetch.
- However, async state updates spread the current closure's `adminClassificationState`, so overlapping draft view/action/match calls can reintroduce older error maps.
- A backend selector mismatch can set `response_draft_classification_mismatch` while a later draft view still returns a body for the message. This produces the observed "red banner plus draft" disagreement.

`operator_match_context` and `admin_draft_view` can show different apparent state because:

- `operator_match_context` reports only latest validation summary from current draft/classification.
- `admin_draft_view` returns ordered draft rows and body omission decisions.
- Both are message-scoped for current draft, while UI actions are selected-classification scoped.

## Root Cause Analysis

1. Did matching itself break the system, or did draft/fallback logic break after matching?

Draft/fallback/persistence/UI logic broke after matching was added. Matching adds context and weak/suggested links, but the major instability is current draft outcome handling, fallback validation, and selector mismatch.

2. Is matching deterministic enough?

Yes for the current scope. It is deterministic code and database lookups. Strong matches are reasonably strict. Weak matches are properly marked `suggested`, but downstream paths must continue treating them as operator-only.

3. Is AI being used in places where code should be used?

Matching is code-based. Classification and drafting use AI appropriately. The risky part is that AI draft validation and fallback policy are encoded as broad regex rules over text instead of a smaller typed claim model. Also buyer-stated claims are not structured, so validation must infer intent from text.

4. Are weak/suggested matches being treated too strongly?

The verified context builder tries to prevent this by excluding weak/suggested links from buyer-facing context. However, suggested links are still included in `deterministic_links` and broader admin context sent to the AI input. The prompt says not to use them as facts, but the validator/fallback interaction shows the system still becomes brittle around weak context.

5. Is fallback being used too early?

Fallback is used after AI validation failure, not before AI. But because the validator is broad and sensitive, AI drafts can be rejected for wording that could be repaired or interpreted as buyer-stated acknowledgement. That makes fallback too common in practice.

6. Is fallback being validated with the wrong rules?

Yes. Fallback goes through the same broad validator. The safe-fallback profile is only a narrow relaxation. A deterministic fallback should instead be checked only for forbidden specific claims and unsafe commitments.

7. Are invalid drafts being saved as current?

Yes. `insertResponseDraft()` always supersedes previous current drafts and inserts the new draft as current, even for `invalid` and `error` validation states.

8. Is the UI reading the wrong draft version?

It can. `admin_draft_view` ignores `classificationId` when `messageId` is present, so it may return a current draft for the message that belongs to a different classification than the selected UI row. That can then cause regenerate/review classification mismatch.

9. Is the system confusing buyer-stated claims with verified facts?

Partially. The prompt states the distinction, and validation has `buyerStatedGrounding`, but buyer-stated claims are not first-class structured data. The validator can still flag acknowledgements of buyer-reported issues as unsupported if wording becomes too factual.

## Why Things Broke After eBay Matching Was Added

Before eBay matching, draft input was mostly email text and classification. AI could personalize freely from the email, and the UI could show the resulting draft.

After eBay matching:

- The draft input included deterministic links and verified order context.
- The prompt became stricter about verified facts.
- The validator began blocking unsupported order/shipping/refund/item/timeline claims.
- Fallback became the recovery path for invalid AI drafts.
- Fallback itself was validated by the same broad validator.
- Draft persistence saved every outcome as current.
- UI draft lookup was message-scoped while actions were classification/draft scoped.

This turned validation/fallback from a guardrail into a state machine with multiple failure-current outcomes.

Symptom A, message `4effe1f7-2f82-4a86-b8c4-94e986267986`:

- The described weak/suggested cancellation match fits the path where verified context becomes generic and weak match is operator-only.
- AI may mention cancellation/order details from buyer email or suggested context.
- Validator can flag `fabricated_order_detail` or unsupported claim.
- Fallback may be generated.
- If fallback validation fails, the catch inserts a current error draft with `safe_fallback_validation_failed`.
- Later patches or reruns can create a valid fallback, causing behavior to appear to change over time.

Symptom B, no deterministic match emails:

- No-match emails should have generic verified context and still allow AI to personalize from buyer-stated content.
- If AI wording triggers unsupported-claim validation, fallback runs.
- If fallback is validated by broad rules and fails, no-match emails can also produce `safe_fallback_validation_failed`.
- Thus no-match behavior changed because fallback/validation/persistence changed, not because matching produced bad links.

Symptom C, stale red error banner:

- `response_draft_classification_mismatch` is likely caused by `admin_draft_view` returning a message-current draft whose `classification_id` differs from the selected classification, followed by regenerate/review with both selected classification ID and draft ID.
- A stale UI state race can keep or reintroduce the action error while draft view succeeds.
- Backend can also return `ok: true` with a current error draft for caught fallback failures, making success/failure semantics unclear.

Symptom D, over-generic fallback:

- Fallback is deterministic and only has five broad templates.
- It does not extract a concise buyer-stated issue phrase.
- Once validator rejects AI drafts frequently, fallback becomes the common path and personalization disappears.

## Deterministic vs AI Responsibilities

Current good split:

- Deterministic: Outlook persistence, normalization, identifier extraction, matching, link confidence/status.
- AI: classification and response drafting.
- Deterministic: validation and persistence.

Needed sharper split:

- Deterministic matcher must only produce links and confidence/status.
- Verified context builder must decide what is buyer-facing.
- AI may draft from email and verified context.
- Validator should validate claims, not enforce generic wording.
- Fallback should be deterministic and should not depend on the full AI validator.

## Current Bugs / Risks

- Current invalid/error draft overwrite: error and invalid rows supersede previous usable drafts.
- Fallback validation can fail and then save an error draft as current.
- `admin_draft_view` ignores `classificationId` when `messageId` is present.
- Regenerate/review validates selected classification ID against returned draft ID, causing `response_draft_classification_mismatch`.
- API returns `ok: true` for caught draft-generation errors after saving error drafts, so UI may treat failed generation as a completed action.
- Fallback profile is too narrow and still tied to full AI validator.
- Suggested/weak links are available in AI input as deterministic links, relying on prompt compliance and validation rather than typed separation.
- Buyer-stated claims are not structured separately from verified facts.
- UI async state spreads can reintroduce stale error maps during overlapping loads/actions.
- `operator_match_context` validation summary and `admin_draft_view` draft body response can appear inconsistent because they summarize different slices of state.

## Recommended Clean Architecture

Target shape:

1. Deterministic extraction/matching.
2. Verified context builder.
3. AI personalized drafting from email plus verified facts.
4. Strict validation of unsupported factual claims.
5. Deterministic safe fallback only if AI draft invalid.
6. Fallback checked only for forbidden specific claims.
7. Save exactly one current draft outcome per generation action.
8. UI reads one canonical current draft.

More detailed target:

- Keep `email_message_links` as the durable matching table.
- Treat `confirmed` high-confidence exact matches as buyer-facing eligible.
- Treat `suggested`, title-only, internal-label-only, buyer username/email-only, and low confidence matches as operator-only.
- Build a typed draft input with:
  - `buyer_stated_claims`
  - `verified_facts`
  - `unknown_facts`
  - `forbidden_claims`
  - `operator_only_context`
- Do not send operator-only context to the AI in a way that can be mistaken for buyer-facing fact, or label it separately and exclude it from the drafting facts object.
- Validate AI drafts against typed verified facts and buyer-stated acknowledgements.
- Make fallback independent: deterministic, short, personalized from safe buyer-stated issue label, and checked only for forbidden specifics/promises.
- Preserve the last usable current draft when a generation attempt fails, or store failure as non-current attempt/audit.
- Make `admin_draft_view` and review/regenerate selectors use the same canonical draft identity.

## Minimal Repair Plan

Step A - Freeze and document current broken paths.

- Capture current state transitions for AI valid, AI invalid, fallback valid, fallback invalid, OpenAI error, malformed JSON, regenerate, human edit, approve, reject.
- Add regression fixtures for known messages without changing behavior first.

Step B - Centralize draft outcome decision.

- Create one draft outcome decision point: `valid_ai`, `valid_fallback`, `invalid_blocked`, `generation_error`.
- Decide explicitly which outcomes may become current.

Step C - Separate AI validator from fallback forbidden-claim checker.

- Keep strict validator for AI drafts.
- Add a smaller fallback checker that only rejects forbidden specific claims, commitments, tracking/order/refund/timeline specifics, legal admissions, and empty body.

Step D - Ensure only one current usable draft is saved per generation action.

- Valid AI and valid fallback can become current.
- Invalid/error attempts should be stored as non-current audit attempts, or should not supersede previous usable current draft.
- Never let `safe_fallback_validation_failed` become the current draft body state.

Step E - Fix `admin_draft_view`/UI current draft selection.

- When both `messageId` and `classificationId` are supplied, filter by both or return canonical message-current plus explicit classification mismatch metadata.
- UI should not pass a draft ID from one classification with another classification ID.
- Clear action errors after successful draft load using functional/state-safe updates.

Step F - Restore personalized drafting from email content.

- Add structured `buyer_stated_claims` extraction from subject/body/classification summary.
- Let fallback include one safe acknowledgement phrase from buyer-stated content without asserting truth.

Step G - Add regression tests for known messages.

- Weak/suggested cancellation message `4effe1f7-2f82-4a86-b8c4-94e986267986`.
- No deterministic match buyer email.
- Confirmed order number exact match.
- Suggested item number only.
- Fallback validation should not fail for deterministic fallback templates.
- Invalid/error generation should not hide last valid current draft.
- `admin_draft_view` should not return a draft incompatible with selected classification without making that explicit.

## Suggested Execution Steps

1. Add read-only unit-style tests around `validateResponseDraft()`, `buildSafeFallbackDraft()`, `validateSafeFallbackDraft()`, and draft outcome selection.
2. Add a draft outcome type and tests before changing persistence.
3. Change fallback validation to use a dedicated fallback checker.
4. Change persistence so invalid/error attempts do not supersede current usable drafts.
5. Change `admin_draft_view` selector semantics and UI request handling together.
6. Add structured buyer-stated claims to draft input.
7. Re-run known-message regressions and manually verify UI banners/content states.

## Files Inspected

- `email-triage.js`
- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/migrations/20260520143000_email_triage_persistence_foundation.sql`
- `supabase/migrations/20260520193000_email_triage_classification_schema_foundation.sql`
- `supabase/migrations/20260522120000_email_triage_response_draft_persistence.sql`
- `supabase/migrations/20260515090000_ebay_pending_orders_worker_checkout.sql`
- `supabase/migrations/20260518165000_ebay_shipping_label_attachments.sql`
- `supabase/migrations/20260521123000_ebay_returns_workflow.sql`
- `supabase/migrations/20260521164500_ebay_return_task_queue.sql`
- `supabase/migrations/20260521220500_ebay_return_message_logs.sql`
- `supabase/migrations/20260522103000_ebay_order_coordination_tasks.sql`
- Existing email-triage docs under `docs/email-triage/`

## Tests / Checks Performed

- `node --check email-triage.js`: passed.
- `deno check supabase/functions/microsoft-email-classify/index.ts`: not run because `deno` is not installed in the local shell.
- `deno check supabase/functions/microsoft-email-process/index.ts`: not run because `deno` is not installed in the local shell.
- Read-only Supabase data queries were not run because this audit did not have an available configured read-only database session in the local shell. Runtime symptoms were analyzed from code paths and the provided observations.

## Open Questions

- Should `admin_draft_view` be message-canonical only, classification-canonical only, or explicitly support both with mismatch metadata?
- Should invalid/error draft attempts be stored in `email_response_drafts` as non-current rows, or should they move to a separate draft attempt/audit table in a future schema change?
- Should suggested matches ever be promotable automatically after multiple weak signals, or only by operator confirmation?
- Should `buyer_stated_claims` be extracted deterministically, by classifier output, or by a small separate structured step?
- Should fallback drafts preserve buyer display name, or always use neutral `Hi,` to reduce validation and privacy risk?
- Should confirmed tracking-label metadata be considered enough to state "tracking is available", or should only explicit `tracking_number` be buyer-facing?
