# Step 4B.4 - Classification Validation Hardening + Replay Framework

Date: 2026-05-21

## Scope

This step hardens the existing `microsoft-email-classify` Edge Function and adds replay support for classification jobs.

Added:

- `dry_run`
- `replay_classification`
- stricter local validation
- safety overrides
- grounded entity cleanup
- `classification_replay` operational audit events

Not added:

- frontend UI
- Step 4B.5 admin classification view endpoint
- reply drafting, email sending, Outlook mutation, eBay/order/inventory/sales mutation
- embeddings or semantic search

## Files Changed

- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/migrations/20260521120000_email_triage_classification_replay_event.sql`
- `docs/email-triage/STEP_4B_CLASSIFICATION_VALIDATION_REPLAY.md`
- `docs/email-triage/fixtures/STEP_4B4_CLASSIFIER_VALIDATION_FIXTURES.json`

No `supabase/config.toml` change was needed.

## New Mode: dry_run

`dry_run` runs the classifier input assembly, OpenAI call, local validation, safety override, and hallucination guard without writing classification rows and without superseding existing classifications.

Selectors:

- `messageId`
- `mailboxId`
- optional `startDate`
- optional `endDate`
- `limit`

Safety behavior:

- does not insert into `email_message_classifications`
- does not update existing classification rows
- does not enqueue jobs
- returns safe counters only
- does not return raw email body text or raw AI output

Response shape:

```json
{
  "ok": true,
  "mode": "dry_run",
  "messages_tested": 1,
  "valid_outputs": 1,
  "invalid_outputs": 0,
  "would_classify": 1
}
```

## New Mode: replay_classification

`replay_classification` creates new queued `classify` jobs for already-classified or previously failed messages. It does not call OpenAI. Processing happens later through `process_queued`.

Selectors:

- `messageId`
- `mailboxId`
- optional `startDate`
- optional `endDate`
- `classificationRunId`
- `limit`

Replay behavior:

- creates new `email_processing_jobs` rows with replay-specific `input_version`
- preserves old jobs
- preserves old classification rows
- skips messages with active `queued` or `running` classify jobs
- writes one `email_operational_events` row with `event_type = classification_replay`
- respects repeated requests with the same `idempotencyKey`

Response shape:

```json
{
  "ok": true,
  "mode": "replay_classification",
  "jobs_enqueued": 5,
  "jobs_skipped_active": 2,
  "operation_id": "...",
  "operational_event_id": "..."
}
```

## Validation Rules

Local validation now enforces:

- `category` enum
- `subcategory` string or `null`
- `priority` enum
- `urgency` enum
- `recommended_action` enum
- `confidence` number from `0` to `1`
- compact `summary`
- compact `reasoning_summary`
- `detected_entities` object with arrays only
- known `safety_flags` only
- `response_needed` boolean
- `human_review_required` boolean

Invalid JSON or schema-invalid AI output fails safely. The job stores safe error codes and compact diagnostics on `email_processing_jobs.metadata`; it does not store raw body text or full OpenAI payloads.

## Safety Overrides

The function forces `human_review_required = true` when:

- `confidence < 0.75`
- category is refund, return, cancellation, item-not-received, item-not-as-described, payment issue, or account security
- safety flags include `low_confidence`, `account_security`, or `payment_or_refund`

The function forces:

- `low_confidence` safety flag when `confidence < 0.75`
- `recommended_action = security_review` when `category = account_security`
- `recommended_action = review_only` when confidence is poor or category falls back to `internal_or_other`

A small safe regression fixture file was added at `docs/email-triage/fixtures/STEP_4B4_CLASSIFIER_VALIDATION_FIXTURES.json` to capture representative expected behavior for low confidence, account security, and ungrounded entity cleanup. It contains no real message bodies.

## Hallucination Guards

Entities are only kept when grounded in safe classifier context:

- classifier body text
- message subject/from/sender/reply-to metadata
- recipient metadata
- deterministic link `matched_value`

Guarded keys:

- `order_numbers`
- `item_numbers`
- `buyer_usernames`
- `tracking_numbers`

Ungrounded entities are removed. The classification is not failed for a small number of removals. Safe metadata is stored in classification evidence:

```json
{
  "validation_metadata": {
    "hallucination_guard": {
      "removed_entities": 1
    }
  }
}
```

## Operational Audit Event

Classification replay writes to `email_operational_events`:

- `event_type = classification_replay`
- `mailbox_id` when known
- `message_ids`
- `new_job_ids`
- `job_types = ['classify']`
- `reason`
- `initiated_by`
- `initiated_by_email`
- `processor_version`
- `replay_source`
- `idempotency_key`
- safe selector and counter payload

The migration widens the existing event type check constraint to allow `classification_replay`.

## Manual Verification

Deploy:

```bash
npx supabase db push
npx supabase functions deploy microsoft-email-classify --project-ref byhytmarmigalvawkedi
```

Dry run one message from browser DevTools:

```js
const { data } = await window.supabase.auth.getSession();
await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "dry_run",
    messageId: "<email_message_id>",
    limit: 1
  })
}).then((response) => response.json());
```

Replay classification for one message:

```js
const replay = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "replay_classification",
    messageId: "<email_message_id>",
    reason: "manual Step 4B.4 replay verification",
    idempotencyKey: "manual-classification-replay-<email_message_id>-1",
    limit: 1
  })
}).then((response) => response.json());
replay;
```

Process queued jobs after replay:

```js
await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "process_queued",
    limit: 5
  })
}).then((response) => response.json());
```

Duplicate replay attempt with the same idempotency key:

```js
await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "replay_classification",
    messageId: "<email_message_id>",
    reason: "manual Step 4B.4 replay verification",
    idempotencyKey: "manual-classification-replay-<email_message_id>-1",
    limit: 1
  })
}).then((response) => response.json());
```

Expected duplicate response:

```json
{
  "ok": true,
  "mode": "replay_classification",
  "idempotent": true,
  "jobs_enqueued": 1,
  "jobs_skipped_active": 0
}
```

## SQL Verification

Check classify jobs:

```sql
select
  id,
  message_id,
  job_type,
  status,
  input_version,
  metadata->>'operational_event_id' as operational_event_id,
  created_at
from public.email_processing_jobs
where job_type = 'classify'
order by created_at desc
limit 20;
```

Check classification rows:

```sql
select
  id,
  message_id,
  category,
  confidence,
  requires_human_review,
  recommended_action,
  safety_flags,
  detected_entities,
  validation_status,
  evidence->'validation_metadata' as validation_metadata,
  processing_job_id,
  input_version,
  created_at
from public.email_message_classifications
where source = 'ai'
order by created_at desc
limit 20;
```

Check replay audit rows:

```sql
select
  id,
  event_type,
  mailbox_id,
  message_ids,
  new_job_ids,
  job_types,
  reason,
  initiated_by_email,
  processor_version,
  replay_source,
  idempotency_key,
  payload,
  created_at
from public.email_operational_events
where event_type = 'classification_replay'
order by created_at desc
limit 20;
```

Check invalid output handling:

```sql
select
  id,
  status,
  last_error_code,
  metadata->'validation_errors' as validation_errors,
  metadata->'validation_diagnostics' as validation_diagnostics,
  metadata->>'phase' as phase
from public.email_processing_jobs
where job_type = 'classify'
  and status = 'failed'
order by updated_at desc
limit 20;
```

## Known Limitations

- `dry_run` may still call OpenAI, so OpenAI secrets must be configured.
- The hallucination guard checks exact normalized substring presence; it does not perform fuzzy matching.
- Replay only queues jobs. It intentionally does not process queued jobs unless `process_queued` is called separately.
- Invalid classification rows are only written where the classifier intentionally records a validation failure; raw AI payloads are never stored.

## Deferred 4B.5 Work

Deferred until explicit approval:

- admin classification view endpoint
- filtering/searching classifications from the frontend
- human review UI
- any action workflow based on classifications

## Next Recommended Prompt

Proceed only after approval:

```text
Step 4B.5 - Admin Classification View Endpoint
```
