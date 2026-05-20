# Step 4A.2-4A.3 - Email Persistence Foundation

Date: 2026-05-20

## What Changed

This step adds the durable database foundation and first mailbox bootstrap endpoint for the OG Email Triage Assistant.

New migration:

```text
supabase/migrations/20260520143000_email_triage_persistence_foundation.sql
```

New Edge Function:

```text
supabase/functions/microsoft-email-bootstrap/index.ts
```

Updated function config:

```text
supabase/config.toml
```

## Tables Created

The migration creates these additive tables:

```text
public.email_mailboxes
public.email_folders
public.email_messages
public.email_message_recipients
public.email_message_bodies
public.email_attachments
public.email_sync_states
public.email_sync_runs
public.email_processing_jobs
public.email_message_classifications
public.email_message_links
```

The tables are provider-neutral where useful, but Microsoft mailboxes are anchored to:

```text
public.microsoft_mailbox_connections.id
```

No existing eBay, inventory, sales, or Microsoft OAuth tables are mutated.

## Constraints And Indexes

The migration adds idempotency and query indexes for:

- one active provider/mailbox email row
- one mailbox per Microsoft connection
- unique provider folder per mailbox
- unique provider message id per mailbox
- partial unique immutable and internet message identifiers
- received-date, conversation, sender, and subject message lookup
- recipient, attachment, sync-state, sync-run, job, classification, and link lookup
- future email-to-eBay/order/item/sale links

`updated_at` triggers use the existing repo convention:

```text
public.set_updated_at()
```

## RLS And Grants Summary

RLS is enabled on every new table.

Browser access posture:

- `anon`: no access
- `authenticated`: admin-only `SELECT` on safer metadata/operational tables
- `service_role`: full backend access

Direct browser access is intentionally not granted for:

```text
public.email_message_bodies
public.email_sync_states
```

That keeps body content and Graph delta checkpoints behind service-role Edge Functions until a narrower UI/API contract exists.

## Security Boundary

This step preserves the Step 3.5D security model:

- refresh tokens stay encrypted in `public.microsoft_mailbox_connection_secrets`
- access tokens are refreshed in memory inside Edge Functions only
- browser JavaScript never receives Microsoft tokens
- browser JavaScript never calls Microsoft Graph directly
- Graph `delta_link` is stored only in `email_sync_states` and is not browser-readable
- raw message bodies are not ingested or exposed in this step

Safe logs include only phase, status/error code, mailbox id, connection id, and counts.

## Bootstrap Function Behavior

`microsoft-email-bootstrap`:

1. Requires `verify_jwt = true`.
2. Validates the Supabase bearer token.
3. Confirms the caller is an active admin employee.
4. Loads the single active Microsoft mailbox connection.
5. Ensures one `email_mailboxes` row for the Microsoft connection.
6. Decrypts the stored refresh token server-side.
7. Refreshes the Microsoft access token and rotates the refresh token if Microsoft returns a new one.
8. Calls Microsoft Graph only for Inbox folder metadata:

```text
GET /me/mailFolders/inbox?$select=id,displayName,parentFolderId,totalItemCount,unreadItemCount
```

9. Upserts the Inbox row into `email_folders`.
10. Upserts the Inbox `folder_messages` row into `email_sync_states`.
11. Writes an `email_sync_runs` record with `run_type = bootstrap`.
12. Returns only a safe summary:

```json
{
  "ok": true,
  "mailbox_id": "...",
  "folders_upserted": 1,
  "sync_states_upserted": 1
}
```

## Intentionally Not Implemented

This step does not:

- ingest messages
- call `/me/messages`
- call message delta endpoints
- store message rows from Graph
- store body content
- download or store attachment bytes
- enqueue processing jobs
- classify emails with AI
- create embeddings
- match emails to eBay orders/items
- create draft replies
- send email
- modify Outlook categories
- add cron jobs
- add webhooks
- switch to the GitHub Pages production URL
- change Microsoft OAuth redirect URIs

## Deploy

Push the migration:

```bash
npx supabase db push
```

Deploy the bootstrap function:

```bash
npx supabase functions deploy microsoft-email-bootstrap --project-ref byhytmarmigalvawkedi
```

The function uses the existing Microsoft/Supabase secrets from Step 3.5D, including:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT_ID
MICROSOFT_TOKEN_ENCRYPTION_KEY
MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION
MICROSOFT_GRAPH_SCOPES
```

Current local settings remain:

```env
EMAIL_TRIAGE_APP_URL=http://127.0.0.1:3000/email-triage.html
MICROSOFT_TENANT_ID=consumers
```

## Manual Test

From the local admin app, sign in as an active admin and ensure Outlook is connected.

From browser DevTools, call:

```js
const { data: { session } } = await window.supabase.auth.getSession();

const response = await fetch(
  `${window.SUPABASE_URL}/functions/v1/microsoft-email-bootstrap`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: window.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: "{}",
  },
);

await response.json();
```

Expected response:

```json
{
  "ok": true,
  "mailbox_id": "...",
  "folders_upserted": 1,
  "sync_states_upserted": 1
}
```

## Verify In Supabase

Expected database state:

- `email_mailboxes` has one Microsoft row for the active connection
- `email_folders` has at least one Inbox row
- `email_sync_states` has at least one Inbox `folder_messages` row
- `email_sync_runs` has a `bootstrap` run with `status = succeeded`
- `email_messages` remains empty
- `email_message_bodies` remains empty
- `email_message_classifications` remains empty
- no token fields or Graph token payloads appear in new email tables

Re-run the bootstrap function to confirm it is idempotent and does not duplicate mailbox, Inbox folder, or sync-state rows.

## Next Recommended Prompt

Proceed to Step 4A Prompt 2:

```text
Step 4A.4-4A.6 Initial + Incremental Sync Engine
```

That next step should implement controlled message ingestion and Graph delta checkpointing. It should still keep AI classification, deterministic matching, webhooks, and replay endpoints deferred.
