# Step 4B.1 - AI Classification Audit + Architecture Plan

Date: 2026-05-20

## Executive Summary

Step 4A is ready for an AI classification layer. The repository now has durable Outlook ingestion, normalized body text, recipients, deterministic links, processing jobs, and operational replay. Step 4B should add classification as a replayable `classify` processing job that reads stored email context server-side, calls OpenAI only from a Supabase Edge Function, validates strict JSON, writes auditable classification rows, and never returns raw message bodies or OpenAI secrets to the browser.

Recommendation: proceed with Step 4B implementation after review, using additive schema changes to strengthen `email_message_classifications` for prompt/model metadata, validation status, detected entities, safety flags, and job/run traceability. The AI output should be advisory only; no order, inventory, sale, Outlook, or eBay mutations should be triggered by classification results.

## Current Architecture Recap

The current email pipeline is:

```text
Outlook / Microsoft Graph
  -> encrypted OAuth persistence
  -> replay-safe Graph delta sync
  -> email_messages / bodies / recipients / links
  -> deterministic processing jobs
  -> operational replay and monitoring
```

Important existing boundaries:

- Static `email-triage.html`, `email-triage.js`, and `email-triage.css` remain the admin surface.
- Supabase Edge Functions are the only backend.
- Service-role operations happen only inside Edge Functions.
- Microsoft refresh tokens stay encrypted in `microsoft_mailbox_connection_secrets`.
- Access tokens are request-local and never persisted.
- Raw body content and Graph delta links are not browser-readable.
- Step 4A already permits `email_processing_jobs.job_type = 'classify'`, but no classifier implementation exists yet.

## Agreement Gate

Files reviewed:

- `docs/email-triage/EMAIL_TRIAGE_REPO_AUDIT.md`
- `docs/email-triage/STEP_3_MICROSOFT_GRAPH_POC.md`
- `docs/email-triage/STEP_3_5D_MAILBOX_PERSISTENCE_AUDIT.md`
- `docs/email-triage/STEP_3_5D_SCHEMA_MIGRATION.md`
- `docs/email-triage/STEP_3_5D_CALLBACK_PERSISTENCE.md`
- `docs/email-triage/STEP_3_5D_PERSISTENT_LATEST_MESSAGES.md`
- `docs/email-triage/STEP_3_5D_MAILBOX_STATUS.md`
- `docs/email-triage/STEP_3_5D_UI_STATUS_AUTOLOAD.md`
- `docs/email-triage/STEP_3_5D_DISCONNECT_RECONNECT_CONTROLS.md`
- `docs/email-triage/STEP_4A_EMAIL_PERSISTENCE_PLAN.md`
- `docs/email-triage/STEP_4A_PERSISTENCE_FOUNDATION.md`
- `docs/email-triage/STEP_4A_SYNC_ENGINE.md`
- `docs/email-triage/STEP_4A_PROCESSING_MATCHING.md`
- `docs/email-triage/STEP_4A_OPERATIONS_REPLAY.md`
- `email-triage.html`
- `email-triage.js`
- `email-triage.css`

Functions reviewed:

- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`
- `supabase/functions/microsoft-mailbox-status/index.ts`
- `supabase/functions/microsoft-mailbox-disconnect/index.ts`
- `supabase/functions/microsoft-email-bootstrap/index.ts`
- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-ops/index.ts`
- `supabase/functions/generate-inventory-copy/index.ts`
- `supabase/functions/process-inventory-image/index.ts`

Migrations reviewed:

- `supabase/migrations/20260520103000_email_triage_microsoft_mailbox_connections.sql`
- `supabase/migrations/20260520143000_email_triage_persistence_foundation.sql`
- `supabase/migrations/20260520170000_email_triage_operational_events.sql`
- Relevant migration list under `supabase/migrations/*`

OpenAI patterns reviewed:

- `generate-inventory-copy`
- `process-inventory-image`
- `supabase/config.toml` OpenAI env reference

Classification table reviewed:

- `public.email_message_classifications`

Assumptions made:

- The MVP remains single active Outlook mailbox, though email persistence is already provider-neutral.
- Classification should run after sync and normalization, not inside Graph sync.
- Classification will read `normalized_text` first and fall back to `body_text` or `body_preview` only when needed.
- The first classifier should classify emails, not draft replies, send messages, mutate Outlook categories, or change eBay/order/inventory records.
- Prompt/model choices should be configurable through Edge Function secrets and documented at implementation time.

Risks / unresolved questions:

- Actual mailbox volume and body length distribution are unknown.
- Retention policy for stored raw HTML and normalized text is still not defined.
- The first taxonomy may need adjustment after sampling real eBay emails.
- OpenAI model choice should be confirmed against current official OpenAI docs when implementation starts.
- Low-confidence and sensitive categories need an admin review workflow before any downstream automation.

## Files Reviewed

The audit covered the required Step 3.5D and Step 4A documents, the Microsoft Graph Edge Functions, the current email triage frontend files, Supabase function config, the three email-triage migrations, and the two existing OpenAI-backed inventory functions.

The implementation confirms the intended architecture: no Next.js, Express, React migration, long-running worker, new backend service, or new package manager is needed for Step 4B.

## OpenAI Pattern Audit

`generate-inventory-copy`:

- Reads `OPENAI_API_KEY` and `OPENAI_MODEL` from `Deno.env`.
- Uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to sign storage URLs.
- Calls `https://api.openai.com/v1/responses`.
- Sends a system prompt plus user prompt and an image URL.
- Requests valid JSON in prompt prose, then parses `output_text`.
- Validates only by `JSON.parse` plus required non-empty `generatedTitle` and `generatedDescription`.
- Falls back to deterministic placeholder copy when OpenAI config, request, or parsing fails.
- Returns debug fields such as `openaiStatus`, `openaiErrorSummary`, `parseFailure`, and a raw output preview.
- Logs safe config presence and HTTP status, but does include previews of failed OpenAI bodies/model output.

`process-inventory-image`:

- Reads `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL`, defaulting image model to `gpt-image-1`.
- Uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for storage reads/writes and signed URLs.
- Calls `https://api.openai.com/v1/images/edits`.
- Uses a fixed prompt to isolate jewelry onto a black or white studio background.
- Validates response only by checking for `b64_json` or `url`.
- Returns detailed safe-ish error codes, but some error responses include exception detail or an OpenAI response body slice.
- Has no JSON schema validation because the output is image data.

Reusable helper audit:

- No shared OpenAI client/helper exists.
- Prompt construction, env lookup, response parsing, and error shaping are local to each function.
- Existing pattern supports server-side OpenAI calls, but Step 4B should create classifier-local helpers for schema validation, prompt hashing, input hashing, safe logging, and output normalization.

## Email Data Readiness

Current Step 4A tables contain enough information for a first-pass classifier:

- `email_messages`: subject, normalized subject, sender/from/sender emails and names, received/sent timestamps, importance, body preview, attachment flag, read/draft flags, conversation identifiers, provider metadata.
- `email_message_bodies`: `normalized_text`, `body_text`, `body_html`, hashes, normalization version, redaction status.
- `email_message_recipients`: from/sender/to/cc/bcc/reply-to participants.
- `email_message_links`: deterministic order, order-line, inventory, sale, and customer-identity links with confidence/status.
- `email_processing_jobs`: queue, retry, idempotency, status, input version, and safe job metadata.
- `email_message_classifications`: initial storage for category, confidence, priority, human review flag, evidence, and reasoning summary.
- `email_operational_events`: replay/requeue audit trail for operations.

Recommended classifier inputs:

- Message id, mailbox id, received timestamp, subject, sender/from display name, sender/from email domain or normalized address when needed, reply-to and recipient roles.
- `body_preview`.
- `email_message_bodies.normalized_text` as primary body text.
- `body_text` only if normalized text is missing.
- Existing deterministic links as compact context: link type, status, confidence, match method, matched value, order number/item number/custom label if already available.
- Attachment metadata only when later populated; for now `has_attachments` is enough.
- Existing provider `importance` and `inference_classification` as weak context.

Fields to exclude by default:

- `body_html` and raw HTML.
- `raw_graph_metadata`.
- Microsoft provider ids, immutable ids, etags, change keys, conversation index, delta links, web links unless specifically needed for admin display.
- Refresh tokens, access tokens, token metadata, Graph payloads, and OAuth response data.
- Full recipient lists if not relevant; include roles and normalized addresses/domains only as needed.
- Full deterministic link metadata if it contains large extracted text.

Body text limits:

- Use `normalized_text`, capped to a fixed character budget.
- Recommended MVP budget: first 10,000 to 12,000 characters, plus a final 1,500 to 2,000 character tail when the body is longer.
- Preserve a truncation marker in classifier input metadata, not in the user-facing summary.
- Record `input_hash` over the exact classifier input, including truncation strategy and deterministic-link context.

HTML body handling:

- Exclude HTML by default.
- Use only normalized text for AI classification.
- HTML may be retained in the database for replay/debugging but should not be sent to OpenAI unless a future prompt explicitly needs layout or quoted-thread detection.

Long email strategy:

- Remove obvious repeated whitespace before truncation.
- Prefer current/latest message content if a future quote-stripper is added.
- Until quote stripping exists, send head plus tail so the classifier sees both the initial request and any recent reply context.
- Store `body_truncated: true` and character counts in job/classification metadata.

Deterministic links:

- Include deterministic links as context because they improve category and urgency decisions.
- Keep them compact and clearly label them as deterministic matches, not AI conclusions.
- Confirmed links can raise confidence for `order_paid`, `shipping_issue`, `return_request`, refund, cancellation, and item-specific questions.
- Suggested links should not force a category by themselves.

## Recommended Classification Taxonomy

First-pass categories:

- `buyer_message`
- `order_paid`
- `shipping_label`
- `shipping_issue`
- `return_request`
- `refund_request`
- `cancellation_request`
- `item_not_received`
- `item_not_as_described`
- `payment_issue`
- `offer_or_negotiation`
- `inventory_question`
- `authenticity_or_condition_question`
- `platform_notice`
- `account_security`
- `marketing_or_promotion`
- `spam_or_noise`
- `internal_or_other`

Suggested subcategory examples:

- `condition_question`
- `measurement_question`
- `combined_shipping`
- `tracking_update`
- `late_delivery`
- `damaged_in_transit`
- `return_label`
- `refund_status`
- `cancel_before_ship`
- `cancel_after_ship`
- `payment_failed`
- `offer_counteroffer`
- `listing_detail_question`
- `authenticity_question`
- `platform_policy`
- `login_or_security_alert`
- `newsletter`
- `unclassifiable`

Priority levels:

- `low`: informational, marketing, no action, no operational deadline.
- `medium`: normal buyer or platform message that should be reviewed.
- `high`: order-impacting, buyer waiting, return/refund/cancellation, shipping issue.
- `critical`: account security, payment risk, deadline-sensitive platform enforcement, likely chargeback/escalation.

Urgency levels:

- `none`: no response or action needed.
- `later`: can wait beyond one business day.
- `soon`: should be reviewed within one business day.
- `today`: should be handled same day.
- `immediate`: account/security/escalation or urgent buyer/order issue.

Recommended `recommended_action` values:

- `no_action`
- `archive_or_ignore`
- `review_only`
- `review_and_reply`
- `check_order_status`
- `check_shipping_status`
- `upload_or_verify_tracking`
- `prepare_return_response`
- `prepare_refund_review`
- `prepare_cancellation_review`
- `inspect_listing_or_inventory`
- `escalate_to_admin`
- `security_review`

Booleans:

- `response_needed = true` for direct buyer questions, return/refund/cancellation requests, item-not-received, item-not-as-described, payment issue needing seller action, shipping issue needing seller action.
- `human_review_required = true` for confidence below threshold, sensitive categories, ambiguity, order-impacting actions, account security, refunds, returns, cancellations, or anything involving money/account status.

Confidence thresholds:

- `>= 0.90`: high confidence; still advisory.
- `0.75 - 0.89`: usable but require review for sensitive/order-impacting categories.
- `0.60 - 0.74`: route to human review.
- `< 0.60`: classify as uncertain, set `human_review_required = true`, use `recommended_action = review_only`.

Sensitive categories that should always require human review:

- `account_security`
- `refund_request`
- `return_request`
- `cancellation_request`
- `item_not_received`
- `item_not_as_described`
- `payment_issue`

## Recommended Output JSON Shape

The model should return strict JSON only:

```json
{
  "category": "buyer_message",
  "subcategory": "condition_question",
  "priority": "medium",
  "urgency": "soon",
  "response_needed": true,
  "human_review_required": true,
  "confidence": 0.82,
  "summary": "Buyer is asking whether the watch is the same as another listing.",
  "recommended_action": "review_and_reply",
  "detected_entities": {
    "order_numbers": [],
    "item_numbers": ["287322559538"],
    "buyer_usernames": ["ghostrider-r"],
    "tracking_numbers": []
  },
  "reasoning_summary": "Message contains a direct buyer question about item comparison.",
  "safety_flags": []
}
```

Validation rules:

- `category`, `priority`, `urgency`, and `recommended_action` must be enums.
- `confidence` must be a number from `0` to `1`.
- `summary` should be one short sentence and must not include unsupported claims.
- `reasoning_summary` must be short and must not contain chain-of-thought.
- `detected_entities` values must be arrays of strings.
- `safety_flags` must be an array of enum-like strings, initially allowing values such as `possible_pii`, `payment_or_refund`, `account_security`, `low_confidence`, `ambiguous_order_match`, `body_truncated`, and `possible_spam`.

## Schema Gap Analysis

Current `email_message_classifications` columns:

- `id`
- `message_id`
- `source`
- `classifier_name`
- `classifier_version`
- `category`
- `subcategory`
- `confidence`
- `sentiment`
- `priority`
- `requires_human_review`
- `reasoning_summary`
- `evidence`
- `created_by`
- `created_at`

Sufficient for MVP storage:

- category/subcategory
- confidence
- priority
- human-review flag
- classifier name/version
- short reasoning summary
- evidence JSON

Recommended additive gaps before implementation:

- `urgency text`
- `response_needed boolean`
- `recommended_action text`
- `detected_entities jsonb not null default '{}'::jsonb`
- `safety_flags text[] not null default '{}'`
- `summary text`
- `model_name text`
- `model_version text`
- `prompt_version text`
- `prompt_hash text`
- `input_hash text`
- `raw_safe_output jsonb`
- `validation_status text`
- `validation_errors jsonb not null default '[]'::jsonb`
- `classification_run_id uuid`
- `processing_job_id uuid references public.email_processing_jobs(id) on delete set null`
- `input_version text`
- `classified_at timestamptz`
- optional `superseded_at timestamptz` or `is_current boolean`

Recommended constraints/indexes:

- Check enums for `urgency`, `recommended_action`, and `validation_status`.
- Index `(message_id, created_at desc)`.
- Index `(category, urgency, priority)`.
- Index `(requires_human_review, created_at desc)`.
- Unique current AI classification by `(message_id, source, classifier_name, classifier_version, input_hash)` or use `input_version` if that remains the replay boundary.

Keep changes additive only. Do not drop or rewrite the existing table.

## Processing Job Integration Plan

Use existing `email_processing_jobs` with `job_type = 'classify'`.

Enqueue strategy:

- Enqueue classify jobs only for `email_messages.sync_status = 'active'`.
- Prefer messages with normalized text, but allow body preview fallback.
- Enqueue after `normalize` and `match_order` have run where possible.
- For the first classifier function, default `jobTypes = ['classify']`.
- Avoid duplicate active jobs by checking existing `queued` or `running` classify jobs for the same message before inserting.
- Use the existing unique job shape `(message_id, job_type, input_version)` for replayable versions.

Input version strategy:

- Use a compound input version such as `4b-classifier:v1:prompt:<prompt_hash_prefix>`.
- Include classifier version, prompt version, taxonomy version, truncation version, and deterministic-link context version in the input hash.
- Changing any prompt/schema/truncation behavior should create a new input version rather than rewriting old jobs.

Replay strategy:

- Add `classify` support to operational replay after the classifier is stable.
- Replays should create new jobs with versions like `4b-classifier:v1:replay:<operation_id>`.
- Existing classification rows remain immutable; new rows supersede by recency or `is_current` if added.

Retry strategy:

- Keep `max_attempts = 3`.
- Retry transient OpenAI/network failures with delayed `available_at`.
- Do not retry permanent validation failures indefinitely; mark job failed with `classification_validation_failed`.
- Store safe error codes only.

Failure handling:

- Job failure should write `last_error_code`, safe `last_error_message`, and metadata with phase.
- If OpenAI returns invalid JSON, store a failed job and optionally a classification row with `validation_status = 'invalid'` only if raw safe output is useful.
- Do not log raw body text or full AI output.

Idempotency behavior:

- Before calling OpenAI, compute `input_hash`.
- If a valid classification already exists for the same message, classifier, prompt hash, and input hash, mark the job `skipped` or `succeeded` without another OpenAI call.
- For active duplicate queued/running jobs, skip enqueue.

## Future Edge Function Design

Recommended function:

```text
supabase/functions/microsoft-email-classify/index.ts
```

Supported modes:

- `enqueue_only`
- `process_queued`
- `enqueue_and_process`
- `process_message`
- `replay_classification`

Required behavior:

- `verify_jwt = true` in `supabase/config.toml`.
- Validate Supabase bearer token.
- Require active admin via `employees.role = 'admin'` and `employees.active = true`.
- Use `SUPABASE_SERVICE_ROLE_KEY` only server-side.
- Read OpenAI key only server-side.
- Never expose `OPENAI_API_KEY`.
- Never expose raw body text in responses.
- Never log raw body text, raw Graph payloads, tokens, or full OpenAI output.
- Write classification results to Postgres.
- Store classifier, model, prompt, input hash, validation, and job metadata.
- Return only safe counters and classification ids.

Recommended request examples:

```json
{
  "mode": "enqueue_and_process",
  "limit": 25
}
```

```json
{
  "mode": "process_message",
  "messageId": "00000000-0000-0000-0000-000000000000"
}
```

Safe response shape:

```json
{
  "ok": true,
  "mode": "enqueue_and_process",
  "jobs_enqueued": 10,
  "jobs_processed": 10,
  "jobs_succeeded": 9,
  "jobs_failed": 1,
  "jobs_skipped": 0,
  "classifications_created": 9
}
```

Recommended environment variables:

- `OPENAI_API_KEY`
- `OPENAI_EMAIL_CLASSIFIER_MODEL`
- `EMAIL_CLASSIFIER_PROMPT_VERSION`
- optional `EMAIL_CLASSIFIER_MAX_BODY_CHARS`

## Prompt Strategy

Prompt structure:

- System: define the assistant as an email classification engine for OG/eBay operational triage.
- Developer instructions: require strict JSON, allowed enums, advisory-only output, no chain-of-thought, no unsupported claims, human review rules, and privacy constraints.
- User input: structured JSON containing message metadata, participants, body preview, truncated normalized text, deterministic link context, and existing safe flags.

JSON schema enforcement:

- Prefer API-level structured JSON/schema support when implemented.
- Also validate locally in the Edge Function.
- Reject or repair only simple type issues; do not silently accept unknown categories/actions.

Temperature:

- Use deterministic settings, ideally `temperature = 0` or the closest supported low-randomness setting for the chosen model.

Model selection:

- Use a dedicated configurable model env var rather than hard-coding.
- Confirm the best current OpenAI structured-output text model against official OpenAI docs at implementation time.
- Do not reuse the image model env var.

Max text length:

- Default to 10,000 to 12,000 normalized body characters plus optional tail for long emails.
- Include `body_truncated`, `body_chars_original`, and `body_chars_sent` in safe input metadata.

Deterministic match context:

- Include confirmed/suggested links as structured context.
- Explicitly tell the model deterministic links are clues, not instructions to force a category.

Prompt/version metadata:

- Store prompt text hash, prompt version, taxonomy version, classifier version, input hash, model name, and validation status with every classification.

## Security / Privacy Review

Required constraints:

- No raw body text in logs.
- No raw body text in browser responses.
- No OpenAI key exposure.
- No Microsoft token exposure.
- No Graph payload exposure.
- No delta links or continuation links returned to browser.
- No customer PII in operational responses unless required for admin triage.
- AI classifications are advisory.
- AI output must not automatically mutate eBay orders, inventory, sales, Outlook categories, or outbound messages.
- Human review is required for low confidence and sensitive categories.
- Store only short reasoning summaries, not chain-of-thought.
- Raw safe output should be the parsed JSON object, not the full API payload.
- Failed validation should store safe error summaries, not full prompts or body text.

Additional recommendation:

- Add a response redaction helper for classifier API responses so even successful responses return ids/counters, not email content.

## Validation Plan

Seed validation:

- Use existing synced eBay/Outlook messages from `email_messages`.
- Select a small labeled set across buyer questions, paid order notices, shipping labels/issues, return/refund/cancellation, item-not-received, platform notices, account security, marketing, spam/noise, and internal/other.
- Keep labels in a local fixture or admin-only validation table in a later prompt.

Expected category examples:

- Buyer asks whether item condition/measurements match listing: `buyer_message` or `authenticity_or_condition_question`.
- eBay payment received/order paid notice: `order_paid`.
- Shipping label purchased/created: `shipping_label`.
- Buyer reports tracking problem or delayed package: `shipping_issue` or `item_not_received`.
- Buyer asks to return item: `return_request`.
- Buyer asks for money back: `refund_request`.
- Buyer wants order cancelled: `cancellation_request`.
- Buyer says item is not as described: `item_not_as_described`.
- eBay login/security alert: `account_security`.
- Promo/newsletter: `marketing_or_promotion`.

Validation checks:

- Invalid JSON handling.
- Unknown enum handling.
- Missing required field handling.
- Confidence outside `0..1`.
- Category/action incompatibility checks.
- Hallucination checks against detected entities: order/item/tracking numbers must appear in input or deterministic context.
- Summary length and no chain-of-thought checks.
- Sensitive-category human-review checks.
- Low-confidence human-review checks.
- Body truncation flag propagation.

Regression strategy:

- Store fixture inputs and expected coarse classifications.
- Run classifier in a dry-run/test mode that validates output without writing current classifications.
- Re-run fixtures whenever prompt/model/classifier version changes.
- Compare category, priority, urgency, response_needed, human_review_required, and recommended_action.

## Recommended Implementation Phases

Prompt 1 - 4B.1 AI Classification Audit + Plan:

- Completed by this document.
- No code, migrations, frontend changes, or OpenAI calls.

Prompt 2 - 4B.2 Classification Schema + Job Foundation:

- Add only the recommended classification metadata columns, constraints, and indexes.
- Add classify job support to operational status/replay definitions where needed.
- Do not call OpenAI yet.

Prompt 3 - 4B.3 AI Classifier Edge Function:

- Add `microsoft-email-classify`.
- Implement admin validation, enqueue/process modes, input assembly, prompt hashing, OpenAI call, strict validation, DB writes, idempotency, and safe responses.
- Keep batch size conservative.

Prompt 4 - 4B.4 Batch Processing + Validation Hardening:

- Add dry-run/test mode, validation fixtures, retry handling, confidence rules, invalid-output handling, and replay support.
- Add operational event integration for classification replays.

Prompt 5 - 4B.5 Admin Classification Ops / View Endpoint:

- Add a safe admin endpoint for classification queue/status/results summaries.
- Return classification summaries without raw body text.
- Frontend UI can be considered after endpoint behavior is proven.

Deferred beyond Step 4B:

- Draft replies.
- Sending emails.
- Outlook category writes.
- Embeddings and semantic search.
- Automatic eBay/order/inventory mutations.
- Customer record normalization.
- Multi-mailbox UI.

## Go / No-Go Recommendation

Go for Step 4B after explicit approval, with these conditions:

- Add schema gaps before classifier implementation.
- Keep OpenAI calls server-side only.
- Keep AI output advisory and human-review-compatible.
- Confirm current OpenAI structured-output model choice against official OpenAI docs during implementation.
- Start with small manual batches and validation fixtures before any broader processing.

No implementation should begin until this plan is approved.
