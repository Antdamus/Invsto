# Step 3.5D.6 Disconnect / Reconnect Controls

Date: 2026-05-20

## Function Added

Added:

```text
supabase/functions/microsoft-mailbox-disconnect/index.ts
```

The function requires a valid Supabase bearer token and an active admin employee role. It uses the service-role key server-side to remove the persisted encrypted refresh-token row and mark the active mailbox metadata row as disconnected.

## Disconnect Behavior

When a single active mailbox connection exists, the function:

- deletes the matching row from `public.microsoft_mailbox_connection_secrets`
- updates `public.microsoft_mailbox_connections`
- sets `status = disconnected`
- sets `disconnected_at`, `disconnected_by`, and `updated_at`
- clears `last_error_code` and `last_error_at`

It does not call Microsoft revoke or logout endpoints in this phase.

## Safe Response Shape

Success:

```json
{
  "ok": true,
  "disconnected": true
}
```

Safe errors only:

- `mailbox_not_connected`
- `disconnect_failed`
- `multiple_active_connections`
- `unauthorized`
- `forbidden`

The function does not return token material, encrypted token fields, IVs, access tokens, refresh tokens, raw Microsoft payloads, or metadata JSON.

## Frontend Changes

Updated:

- `email-triage.html`
- `email-triage.css`
- `email-triage.js`

When the mailbox is active, the page shows:

- Refresh
- Reconnect Outlook
- Disconnect Outlook

Disconnect asks for lightweight confirmation, calls `microsoft-mailbox-disconnect`, clears rendered mailbox metadata and messages after success, and returns the page to the not-connected state with `Connect Outlook Mailbox` as the primary action.

Reconnect continues to use the existing `microsoft-auth-start` OAuth flow.

## Config

`supabase/config.toml` includes:

```toml
[functions.microsoft-mailbox-disconnect]
enabled = true
verify_jwt = true
entrypoint = "./functions/microsoft-mailbox-disconnect/index.ts"
```

## Deployment

Deploy the new function:

```bash
npx supabase functions deploy microsoft-mailbox-disconnect --project-ref byhytmarmigalvawkedi
```

If the existing Step 3.5 functions are not deployed in the target environment, deploy those separately.

## Test Checklist

1. Open `email-triage.html` as an active admin with a connected mailbox.
2. Confirm Refresh, Reconnect Outlook, and Disconnect Outlook are visible.
3. Click Disconnect Outlook and confirm.
4. Verify `public.microsoft_mailbox_connection_secrets` no longer has a row for the connection.
5. Verify `public.microsoft_mailbox_connections.status = disconnected`.
6. Verify `disconnected_at` and `disconnected_by` are populated.
7. Reload the page and confirm it shows the not-connected state.
8. Click Connect Outlook Mailbox and complete OAuth.
9. Confirm latest messages auto-load again after reconnect.
10. Inspect browser network responses and confirm no token fields or secret-table fields are returned.

## Migration And Env Notes

No database migration is needed. The existing Step 3.5D schema already includes the required disconnect columns.

No new environment variable is needed. The function uses the existing:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

## Intentionally Deferred

This step does not implement:

- Step 4 AI classification
- message persistence
- reply drafting
- category writing
- cron jobs
- webhook subscriptions
- production URL migration
- multi-mailbox support
- mailbox switching UX
- analytics dashboards
- Microsoft revoke/logout calls
