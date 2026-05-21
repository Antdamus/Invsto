# Step 4B.3 - AI Classifier Edge Function

Date: 2026-05-20

## Scope

This step adds the first replay-safe AI classifier executor for stored email messages.

Added:

```text
supabase/functions/microsoft-email-classify/index.ts
```

Updated:

```text
supabase/config.toml
```

No migration was needed. Step 4B.2 already added the classification columns and `classify` processing-job support.

## Environment Variables

Required:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
OPENAI_EMAIL_CLASSIFIER_MODEL=gpt-4.1-mini
EMAIL_CLASSIFIER_PROMPT_VERSION=step-4b.3-v1
EMAIL_CLASSIFIER_MAX_BODY_CHARS=14000
```

The OpenAI key is read only inside the Edge Function and is never returned to the browser.

## Modes

Supported modes:

```text
enqueue_only
process_queued
enqueue_and_process
process_message
```

Replay execution is intentionally not implemented in this step.

## Job Flow

The function uses:

```text
public.email_processing_jobs
job_type = classify
max_attempts = 3
```

Enqueue behavior:

- selects active `email_messages`
- creates `classify` jobs with a classifier/prompt/truncation-aware `input_version`
- skips messages with an active queued/running classify job
- uses the existing job uniqueness model to avoid duplicate queued rows

Process behavior:

- claims queued `classify` jobs
- marks each job `running`
- builds safe classifier input
- computes `input_hash` before calling OpenAI
- skips OpenAI if a valid classification already exists for the same message, classifier, classifier version, and input hash
- writes a valid classification row when validation passes
- writes safe failure metadata on job failures

Transient OpenAI/network failures are requeued while attempts remain. Permanent validation failures fail safely.

## Input Assembly

The classifier reads:

```text
email_messages
email_message_bodies
email_message_recipients
email_message_links
```

Body source preference:

```text
normalized_text
body_text
body_preview
```

The function does not send:

```text
body_html
raw_graph_metadata
tokens
delta links
continuation links
OAuth data
```

Deterministic link context is compact and includes only link type, status, confidence, match method, matched value, and boolean presence of linked entities.

## Body Truncation

Body text is normalized for whitespace and truncated deterministically:

```text
head: up to 12000 chars
tail: up to 2000 chars
```

The classifier records safe metadata:

```text
body_truncated
body_chars_original
body_chars_sent
truncation_strategy
body_source
```

The `input_hash` includes the truncation strategy and exact classifier input.

## Validation

The prompt and Responses API request require strict JSON. The function also validates locally before accepting output.

Validated fields:

- `category`
- `urgency`
- `priority`
- `recommended_action`
- `confidence`
- `summary`
- `reasoning_summary`
- `detected_entities`
- `safety_flags`
- booleans for response/review workflow

Invalid or malformed AI output is not silently accepted. The job fails with safe error code `classification_validation_failed`.

## Idempotency

Before OpenAI is called, the function computes `input_hash` from:

- classifier name/version
- taxonomy version
- prompt hash
- job input version
- safe message context
- deterministic link context
- body truncation strategy and truncated text

If a valid classification already exists for:

```text
message_id
classifier_name
classifier_version
input_hash
```

the function skips the OpenAI call and marks the job skipped.

Valid newer classifications supersede older current AI classifications by setting:

```text
is_current = false
superseded_at = now()
```

History is preserved.

## Security Boundaries

The function requires:

```text
authenticated Supabase user
employees.role = admin
employees.active = true
```

Safe responses include counters only. The function does not return classifications, raw body text, raw OpenAI payloads, Graph payloads, tokens, delta links, continuation links, or OAuth data.

The function does not log raw body text or full OpenAI responses.

## Manual Verification

Deploy:

```bash
npx supabase functions deploy microsoft-email-classify --project-ref byhytmarmigalvawkedi
```

From browser DevTools as an active admin:

```js
const { data } = await window.supabase.auth.getSession();

const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "enqueue_and_process",
    limit: 10
  })
});

await response.json();
```

Process one message:

```js
const { data } = await window.supabase.auth.getSession();

const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "process_message",
    messageId: "<email_message_id>",
    limit: 1
  })
});

await response.json();
```

Process queued jobs:

```js
const { data } = await window.supabase.auth.getSession();

const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-classify`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "process_queued",
    limit: 10
  })
});

await response.json();
```

Expected response shape:

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

Database checks:

```sql
select job_type, status, input_version, last_error_code, metadata
from public.email_processing_jobs
where job_type = 'classify'
order by created_at desc
limit 20;
```

```sql
select
  message_id,
  category,
  urgency,
  priority,
  recommended_action,
  validation_status,
  is_current,
  input_hash,
  classified_at
from public.email_message_classifications
where source = 'ai'
order by created_at desc
limit 20;
```

Duplicate run check:

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
    mode: "process_message",
    messageId: "<already_classified_email_message_id>",
    limit: 1
  })
}).then((response) => response.json());
```

Expected checks:

- `classify` jobs are created
- classification rows are written
- invalid model output fails strict validation safely
- duplicate runs with the same `input_hash` skip OpenAI
- no raw body text is returned in HTTP responses
- no raw body text, Graph payloads, tokens, or full OpenAI responses appear in function logs

## Deferred

Deferred to later steps:

- replay execution
- validation hardening/replay framework
- frontend UI
- draft replies
- email sending
- Outlook mutations
- eBay/order/inventory/sales mutations
- embeddings and semantic search
- auto-actions
