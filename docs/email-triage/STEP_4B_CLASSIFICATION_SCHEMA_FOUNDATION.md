# Step 4B.2 - Classification Schema + Job Foundation

Date: 2026-05-20

## Scope

This step prepares the database and operations layer for replayable AI classification jobs. It does not call OpenAI, execute classification, generate summaries, create drafts, send email, mutate Outlook, mutate eBay records, or add embeddings.

## Files Changed

- `supabase/migrations/20260520193000_email_triage_classification_schema_foundation.sql`
- `supabase/functions/microsoft-email-ops/index.ts`
- `docs/email-triage/STEP_4B_CLASSIFICATION_SCHEMA_FOUNDATION.md`

No `supabase/config.toml` change was required because no new Edge Function was created.

## Schema Changes

The migration strengthens `public.email_message_classifications` with additive columns for:

- urgency and response workflow: `urgency`, `response_needed`, `recommended_action`, `summary`
- entity and safety metadata: `detected_entities`, `safety_flags`
- classifier metadata: `model_name`, `model_version`, `prompt_version`, `prompt_hash`, `input_hash`
- safe validation/audit storage: `raw_safe_output`, `validation_status`, `validation_errors`
- replay/job traceability: `classification_run_id`, `processing_job_id`, `input_version`, `classified_at`
- versioning: `is_current`, `superseded_at`

The migration does not drop existing columns and does not rewrite historical classification rows destructively.

## Constraints

Safe check constraints were added for:

- `urgency`: `none`, `later`, `soon`, `today`, `immediate`
- `recommended_action`: `no_action`, `archive_or_ignore`, `review_only`, `review_and_reply`, `check_order_status`, `check_shipping_status`, `upload_or_verify_tracking`, `prepare_return_response`, `prepare_refund_review`, `prepare_cancellation_review`, `inspect_listing_or_inventory`, `escalate_to_admin`, `security_review`
- `validation_status`: `valid`, `invalid`, `partial`, `skipped`, `error`

The constraints are added as `not valid` so they enforce future writes without blocking deployment if older data exists.

## Indexes

The migration adds indexes for:

- `message_id, created_at desc`
- `category, urgency, priority`
- `requires_human_review, created_at desc`
- `response_needed, created_at desc`
- `is_current, created_at desc`
- `processing_job_id`
- `input_hash`
- `classifier_name, classifier_version, prompt_version`

It also attempts to add an idempotency guard:

```sql
unique (message_id, source, classifier_name, classifier_version, input_hash)
where input_hash is not null
```

If existing duplicate rows would conflict with that unique index, the migration raises a notice and skips the unique index instead of forcing unsafe cleanup.

## Job Foundation

`public.email_processing_jobs.job_type` already allowed `classify` in the Step 4A persistence migration. The new migration includes a defensive widening block so environments with an older restrictive `job_type` check can safely accept:

```text
normalize
match_order
classify
draft_response
embed
```

No classifier execution function was created.

## Ops Integration

`supabase/functions/microsoft-email-ops/index.ts` now includes `classify` in `SUPPORTED_JOB_TYPES`.

That makes `classify` visible/allowed in:

- `processing_queue_status`
- `mailbox_health` processing backlog counts
- `replay_processing`
- `requeue_failed_jobs`

Replay and requeue can enqueue `classify` jobs with classify-specific priority placement, but this step does not execute them.

## Manual Verification

Deploy the migration:

```bash
npx supabase db push
```

Deploy the updated ops function:

```bash
npx supabase functions deploy microsoft-email-ops --project-ref byhytmarmigalvawkedi
```

Verify database state:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'email_message_classifications'
  and column_name in (
    'urgency',
    'response_needed',
    'recommended_action',
    'detected_entities',
    'safety_flags',
    'summary',
    'model_name',
    'model_version',
    'prompt_version',
    'prompt_hash',
    'input_hash',
    'raw_safe_output',
    'validation_status',
    'validation_errors',
    'classification_run_id',
    'processing_job_id',
    'input_version',
    'classified_at',
    'is_current',
    'superseded_at'
  )
order by column_name;
```

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.email_processing_jobs'::regclass
  and pg_get_constraintdef(oid) ilike '%classify%';
```

```sql
select indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'email_message_classifications'
  and indexname like 'email_message_classifications%';
```

Verify ops behavior from an active admin session:

```js
const { data } = await window.supabase.auth.getSession();
const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-ops`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ mode: "processing_queue_status" })
});
await response.json();
```

Expected checks:

- `email_message_classifications` has the new columns.
- Existing classification rows remain readable and valid.
- `email_processing_jobs` supports `classify`.
- `microsoft-email-ops` includes `classify` in queue/replay/requeue paths.
- No OpenAI env vars are required yet.

## Deferred

Deferred to Step 4B.3 or later:

- OpenAI model selection and current official docs verification
- `microsoft-email-classify` Edge Function
- prompt construction and strict JSON validation implementation
- classifier execution for queued `classify` jobs
- email summaries/classification outputs
- frontend review UI
- draft replies or send actions
- Outlook/eBay/inventory/sales mutations
- embeddings and semantic search

## Next Recommended Prompt

Proceed with Step 4B.3 only after approval: create the AI classifier Edge Function that claims queued `classify` jobs, builds safe classifier input from stored email data, calls OpenAI from the server, validates strict JSON, and writes auditable `email_message_classifications` rows without mutating any external systems.
