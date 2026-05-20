# Step 4A.4-4A.6 - Initial + Incremental Email Sync Engine

Date: 2026-05-20

## Function Added

Added:

```text
supabase/functions/microsoft-email-sync/index.ts
```

Updated:

```text
supabase/config.toml
```

The function is configured with:

```toml
[functions.microsoft-email-sync]
enabled = true
verify_jwt = true
entrypoint = "./functions/microsoft-email-sync/index.ts"
```

## Sync Modes

The function accepts an authenticated admin `POST` body:

```json
{
  "mode": "initial_backfill",
  "folder": "inbox",
  "maxPages": 1,
  "pageSize": 25
}
```

Supported modes:

- `initial_backfill`
- `incremental`
- `manual_resync`

MVP folder support is Inbox only. `maxPages` is capped to `5`; `pageSize` is capped to `50`.

## Security Boundary

The function preserves the Step 3.5D mailbox security model:

- browser callers must provide a Supabase Auth bearer token
- caller must be an active `employees.role = admin`
- Graph calls happen only inside the Edge Function
- refresh token decryption happens only inside the Edge Function
- access tokens are request-local and are not persisted
- rotated refresh tokens are re-encrypted before storage
- delta links are stored only in `email_sync_states`
- delta links and tokens are never returned to the browser
- raw Graph payloads and message bodies are not logged

Safe logs include only phase, safe reason code, mailbox/folder/run ids, status, page count, message counts, and Microsoft status code.

## Graph Delta And Immutable IDs

Graph message calls use:

```http
Prefer: IdType="ImmutableId"
```

The sync uses the folder delta endpoint:

```text
/me/mailFolders/{provider_folder_id}/messages/delta
```

For incremental mode, if `email_sync_states.delta_link` exists, the stored delta link is used. If the delta token is expired or invalid, the sync state is marked `reset_required` and the browser receives:

```json
{ "ok": false, "error": "delta_reset_required" }
```

## Delta Checkpoint Behavior

The previous good `delta_link` is not overwritten during paging.

The function saves a new `delta_link` and `delta_token_hash` only when Graph returns a final `@odata.deltaLink`. If the safe page cap is reached before a final delta link, the run can still succeed, but `delta_checkpoint_saved` is `false`.

Manual resync starts from a fresh delta path and does not delete existing messages.

## Tables Written

The sync writes:

- `email_sync_runs`
- `email_sync_states`
- `email_mailboxes`
- `microsoft_mailbox_connections`
- `microsoft_mailbox_connection_secrets` when refresh-token rotation occurs
- `email_messages`
- `email_message_recipients`
- `email_message_bodies`

`email_attachments` is intentionally not populated in this step. Messages with `hasAttachments = true` set `email_messages.has_attachments = true` and increment `attachments_seen`.

## Message Persistence

Each active Graph message is idempotently inserted or updated by mailbox and provider message identity.

Persisted message fields include provider ids, immutable id, internet message id, change key, etag, conversation fields, dates, subject, sender/from fields, read/draft flags, attachment flag, web link, importance, body preview, body content type, and small safe metadata.

Recipients are delete-replaced per message for:

- `from`
- `sender`
- `to`
- `cc`
- `bcc`
- `reply_to`

Email addresses are normalized to lowercase in `email_normalized`.

Bodies are stored when Graph returns `body`. HTML bodies are stored as HTML and also converted to a simple normalized text form by stripping tags, decoding common entities, and collapsing whitespace. SHA-256 hashes are stored for text/html/normalized content when present.

Graph tombstones mark matching messages as:

```text
sync_status = tombstone
deleted_at = now()
```

No rows are hard deleted.

## Migration

No new migration was needed for this prompt. The Step 4A.2 persistence foundation already created the required tables, constraints, indexes, grants, and RLS policies.

## Deploy

Deploy the function:

```bash
npx supabase functions deploy microsoft-email-sync --project-ref byhytmarmigalvawkedi
```

The function uses the existing secrets:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=
MICROSOFT_TOKEN_ENCRYPTION_KEY=
MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION=
MICROSOFT_GRAPH_SCOPES=
MICROSOFT_GRAPH_BASE_URL=
MICROSOFT_AUTHORITY_HOST=
```

## Manual Test

Open the local admin app, sign in as an active admin, and confirm Outlook is connected and bootstrap has already run.

From browser DevTools:

```js
const { data } = await window.supabase.auth.getSession();

const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-sync`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "initial_backfill",
    folder: "inbox",
    maxPages: 1,
    pageSize: 10
  })
});

await response.json();
```

Expected response:

```json
{
  "ok": true,
  "mode": "initial_backfill",
  "mailbox_id": "...",
  "folder_id": "...",
  "sync_run_id": "...",
  "pages_fetched": 1,
  "messages_seen": 10,
  "messages_inserted": 10,
  "messages_updated": 0,
  "messages_deleted": 0,
  "attachments_seen": 0,
  "delta_checkpoint_saved": false
}
```

`delta_checkpoint_saved` may be `true` when Graph returns the final delta link within the page cap.

Repeat with:

```json
{
  "mode": "incremental",
  "folder": "inbox",
  "maxPages": 1,
  "pageSize": 10
}
```

Expected repeat behavior:

- no duplicate `email_messages` rows
- `messages_updated` may increase
- final delta checkpoint updates only when Graph returns `@odata.deltaLink`

## Supabase Verification Checklist

Verify:

- `email_messages` has rows for the synced mailbox
- repeated syncs do not duplicate `(mailbox_id, provider_message_id)`
- `email_message_recipients` has normalized recipient rows
- `email_message_bodies` has rows when Graph returned body content
- `email_sync_runs` has a succeeded or failed run with safe counters
- `email_sync_states.status` returns to `idle` after success
- `email_sync_states.delta_link` is populated only internally after a complete delta cycle
- browser response does not include delta links, access tokens, refresh tokens, encrypted token fields, client secret, or raw body payloads

Useful SQL checks:

```sql
select count(*) from public.email_messages;
select count(*) from public.email_message_recipients;
select count(*) from public.email_message_bodies;

select status, run_type, pages_fetched, messages_seen, messages_inserted,
       messages_updated, messages_deleted, attachments_seen, last_error_code
from public.email_sync_runs
order by started_at desc
limit 5;

select status, delta_link is not null as has_delta_link,
       last_successful_sync_at, last_error_code, consecutive_error_count
from public.email_sync_states
order by updated_at desc
limit 5;
```

## Known Limits

- Inbox only.
- Manual invocation only.
- Page cap is intentionally small.
- No cron, webhook, or long-running worker.
- No attachment metadata fetch yet; only message-level `has_attachments` is stored.
- No processing job enqueueing yet.
- No deterministic eBay/order/inventory matching.
- No AI classification.
- No frontend persisted-email UI.

## Intentionally Deferred

This step does not implement:

- Step 4A.7 processing jobs
- Step 4A.8 deterministic matching
- Step 4A.9 operations endpoint
- Step 4A.10 replay endpoint
- Step 4B AI classification
- OpenAI calls or embeddings
- draft replies
- sending email
- Outlook categories
- webhooks or cron jobs
- eBay order or inventory mutation

## Next Recommended Prompt

Proceed to Step 4A Prompt 3:

```text
Step 4A.7-4A.8 Processing + Deterministic Matching
```
