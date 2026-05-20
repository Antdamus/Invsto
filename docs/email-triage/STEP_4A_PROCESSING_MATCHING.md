# Step 4A.7-4A.8 - Processing Jobs + Deterministic Matching

Date: 2026-05-20

## Function Added

Added:

```text
supabase/functions/microsoft-email-process/index.ts
```

Updated:

```text
supabase/config.toml
```

The function is configured with:

```toml
[functions.microsoft-email-process]
enabled = true
verify_jwt = true
entrypoint = "./functions/microsoft-email-process/index.ts"
```

No database migration was needed. The Step 4A persistence foundation already created `email_processing_jobs`, `email_message_bodies`, and `email_message_links`.

## Job Modes

The function accepts an authenticated active-admin `POST` body:

```json
{
  "mode": "enqueue_and_process",
  "limit": 50,
  "messageId": null,
  "jobTypes": ["normalize", "match_order"]
}
```

Supported modes:

- `enqueue_only`
- `process_queued`
- `enqueue_and_process`
- `process_message`

Defaults:

- `mode = enqueue_and_process`
- `limit = 50`
- `jobTypes = ["normalize", "match_order"]`

`limit` is capped at `100`.

For enqueue modes, `limit` controls how many active messages are considered. Because the MVP can enqueue both `normalize` and `match_order` for each message, `enqueue_and_process` may process up to `limit * jobTypes.length` queued jobs in that one manual invocation.

## Tables Read

The function reads:

- `employees` for active admin validation
- `email_messages`
- `email_message_bodies`
- `email_message_recipients`
- `email_processing_jobs`
- `ebay_orders`
- `ebay_order_lines`
- `item_types`
- `sales` indirectly through existing eBay line `sale_id` links

## Tables Written

The function writes only:

- `email_processing_jobs`
- `email_message_bodies.normalized_text`, `normalized_text_sha256`, and `normalization_version`
- `email_message_links`

It does not mutate eBay orders, eBay order lines, inventory rows, sales rows, Outlook data, or classifications.

## Identifier Extraction Rules

The deterministic matcher extracts:

- eBay order numbers: `\b\d{2}-\d{5}-\d{5}\b`
- eBay item numbers: `\b\d{12}\b`
- Transaction IDs: `\b\d{14}\b`
- Internal/listing labels: `#\d+`
- Buyer usernames from subjects like `boostenit sent a message`
- Buyer usernames from sender/from display names as low-confidence candidates
- Buyer emails from participants and message text

Search text is built from subject, body preview, normalized body text, sender/from fields, and recipient emails. Full email bodies are not written to job or link metadata.

## Matching Confidence Rules

Implemented link rules:

- `order_number_exact`: links `email_message_links.link_type = ebay_order`, `confidence = 1.0`, `status = confirmed`
- `item_transaction_exact`: links `link_type = ebay_order_line`, includes parent order when available, `confidence = 1.0`, `status = confirmed`
- `item_number_exact`: links a uniquely matched order line, `confidence = 0.8`, `status = suggested`; ambiguous item numbers are skipped and noted in job metadata
- `buyer_username_exact`: links matching eBay orders only when another order/item/label clue is present, `confidence = 0.6`, `status = suggested`
- `internal_label_custom_label_exact`: links unique `ebay_order_lines.custom_label` matches, `confidence = 0.7`, `status = suggested`
- `internal_label_inventory_exact`: links unique `item_types.barcode` or `item_types.qr_code` matches, `confidence = 0.65`, `status = suggested`
- `internal_label_item_title_contains`: links unique `ebay_order_lines.item_title` contains matches, `confidence = 0.55`, `status = suggested`
- `internal_label_inventory_title_contains`: links unique `item_types.title` contains matches, `confidence = 0.5`, `status = suggested`

Exact duplicate links are avoided. Existing links may be updated only when the new deterministic result improves confidence or upgrades a suggested link to confirmed.

## Processing Behavior

Enqueue behavior:

- Selects `email_messages.sync_status = active`
- Creates `normalize` and/or `match_order` jobs with `input_version = v1`
- Uses the existing job uniqueness constraints to avoid duplicate jobs

Processing behavior:

- Selects queued jobs up to the requested limit
- Marks each job `running`
- Runs deterministic normalization or matching
- Marks each job `succeeded`, `skipped`, or `failed`
- Stores safe job metadata with counts and ambiguity summaries

Safe job metadata shape:

```json
{
  "processor_version": "v1",
  "identifiers_found": {
    "order_numbers": 1,
    "item_numbers": 2,
    "transaction_ids": 1,
    "buyer_usernames": 1
  },
  "links_created": 2,
  "links_updated": 0
}
```

## Safety Boundaries

The function does not:

- call OpenAI
- create AI classifications
- create embeddings
- create drafts
- send emails
- modify Outlook categories
- download attachments
- mutate eBay order/order-line rows
- mutate inventory rows
- mutate sales rows
- create cron jobs, webhooks, operations endpoints, or replay endpoints

Safe errors only are returned, such as:

- `unauthorized`
- `admin_required`
- `configuration_error`
- `enqueue_failed`
- `job_claim_failed`
- `normalization_failed`
- `matching_failed`
- `link_insert_failed`
- `unexpected_error`

## Deploy

Deploy the function:

```bash
npx supabase functions deploy microsoft-email-process --project-ref byhytmarmigalvawkedi
```

No migration deploy is needed for this step if the Step 4A persistence foundation migration has already been applied.

## Manual Test

Open the local admin app, sign in as an active admin, and make sure Outlook messages have already been synced into Supabase.

From browser DevTools:

```js
const { data } = await window.supabase.auth.getSession();

const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-process`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "enqueue_and_process",
    limit: 50,
    jobTypes: ["normalize", "match_order"]
  })
});

await response.json();
```

Expected response shape:

```json
{
  "ok": true,
  "mode": "enqueue_and_process",
  "jobs_enqueued": 20,
  "jobs_processed": 20,
  "jobs_succeeded": 18,
  "jobs_failed": 0,
  "jobs_skipped": 2,
  "links_created": 5,
  "links_updated": 0
}
```

## Verify In Supabase

Expected database state:

- `email_processing_jobs` has `normalize` and `match_order` jobs
- Jobs are marked `succeeded`, `skipped`, or `failed`
- `email_message_bodies.normalized_text` is populated where message content is available
- `email_message_links` may contain suggested or confirmed links
- `email_message_classifications` remains empty
- eBay order, eBay order line, inventory, and sales rows are not mutated

## Known Limits

- Only deterministic regex/rule matching is implemented.
- Buyer username matching is intentionally conservative and requires another contextual clue.
- Repeated eBay item numbers are skipped as ambiguous unless paired with transaction ID.
- Internal `#123` label matching is suggested only and intentionally conservative. Exact `custom_label`, `barcode`, and `qr_code` matches are preferred; title contains matches are lower confidence and unique-match only.
- No full-text search, embedding, AI classification, attachment parsing, or reply drafting is included.
- Job claiming is simple per manual invocation; no long-running worker or advanced lock manager is added.

## Deferred

Deferred to later prompts:

- Step 4A.9 operations endpoint
- Step 4A.10 replay endpoint
- Step 4B AI classification
- embeddings
- frontend UI
- cron jobs or webhook-driven processing
- Outlook category writes or email sending

## Next Recommended Prompt

Proceed only after approval to Step 4A Prompt 4:

```text
Step 4A.9-Step 4A.10 Operations + Replay Endpoints
```
