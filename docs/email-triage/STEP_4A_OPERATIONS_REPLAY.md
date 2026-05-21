# Step 4A.9-4A.10 - Operations Layer + Replay System

Date: 2026-05-20

## What Changed

Added an operational audit table:

```text
supabase/migrations/20260520170000_email_triage_operational_events.sql
```

Added an admin/service operational Edge Function:

```text
supabase/functions/microsoft-email-ops/index.ts
```

Updated function config:

```text
supabase/config.toml
```

## Operational Modes

`microsoft-email-ops` supports:

- `mailbox_health`
- `sync_status`
- `processing_queue_status`
- `matching_statistics`
- `requeue_failed_jobs`
- `replay_processing`
- `resume_sync_replay`

All modes use safe JSON responses. The function never returns refresh tokens, access tokens, encrypted token fields, full delta links, saved continuation links, raw Graph payloads, or message body content.

## Replay Model

Processing replay creates new `email_processing_jobs` rows with an operation-specific `input_version`:

```text
v1:replay:<operation_id>
```

Prior succeeded, skipped, and failed jobs remain untouched. Replay can target:

- one message
- a mailbox date range
- the messages seen during a sync-run window

Existing deterministic processing behavior is unchanged. Replay only queues `normalize` and `match_order`.

## Requeue Model

Failed-job requeue creates new queued jobs with:

```text
v1:requeue:<operation_id>
```

The historical failed jobs remain unchanged. Before inserting new jobs, the function checks for active `queued` or `running` jobs for the same message and job type. Matching active jobs are skipped instead of duplicated.

## Sync Replay Model

`resume_sync_replay` does not implement a new Graph ingestion path. It validates the current `email_sync_states` row, confirms the mailbox is resumable, writes an operational event, and invokes the existing `microsoft-email-sync` function when `execute` is not `false`.

This preserves:

- existing delta-link checkpoint rules
- existing continuation metadata behavior
- existing immutable Graph ID usage
- existing sync-run lifecycle behavior

## Audit Preservation

Every replay/requeue/sync recovery operation writes one immutable `email_operational_events` row with:

- reason
- initiator
- failure category
- notes
- processor version
- replay source
- selected source records
- new job ids
- safe operation payload

The table is admin-readable and service-role-write-only.

## Manual Verification

Deploy:

```bash
npx supabase db push
npx supabase functions deploy microsoft-email-ops --project-ref byhytmarmigalvawkedi
```

Read health from browser DevTools as an active admin:

```js
const { data } = await window.supabase.auth.getSession();
const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-ops`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ mode: "mailbox_health" })
});
await response.json();
```

Replay one message:

```js
await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-ops`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "replay_processing",
    messageId: "<email_message_id>",
    jobTypes: ["normalize", "match_order"],
    reason: "manual replay verification",
    idempotencyKey: "manual-replay-<email_message_id>-1"
  })
});
```

Requeue failed jobs:

```js
await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-ops`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "requeue_failed_jobs",
    mailboxId: "<email_mailbox_id>",
    jobTypes: ["normalize", "match_order"],
    reason: "manual failed-job requeue verification",
    idempotencyKey: "manual-requeue-1"
  })
});
```

Resume sync replay:

```js
await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-email-ops`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    mode: "resume_sync_replay",
    mailboxId: "<email_mailbox_id>",
    reason: "manual sync continuation verification",
    maxPages: 1,
    syncPageSize: 25,
    idempotencyKey: "manual-sync-replay-1"
  })
});
```

Security checks:

- call without `Authorization` and expect `401 unauthorized`
- call with a non-admin authenticated user and expect `403 admin_required`
- call as an active admin and expect success
- verify `email_operational_events` cannot be inserted directly by `anon` or `authenticated`

Database checks:

```sql
select event_type, reason, processor_version, replay_source, created_at
from public.email_operational_events
order by created_at desc
limit 10;

select job_type, status, input_version, metadata->>'operational_event_id' as operational_event_id
from public.email_processing_jobs
where input_version like 'v1:replay:%' or input_version like 'v1:requeue:%'
order by created_at desc
limit 20;
```
