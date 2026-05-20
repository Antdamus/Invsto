# Step 3.5D.5 Mailbox Status And Health Endpoint

Date: 2026-05-20

## Function Added

Added:

```text
supabase/functions/microsoft-mailbox-status/index.ts
```

This Edge Function returns the current persisted Microsoft mailbox connection status to an authenticated active admin. It does not call Microsoft Graph, decrypt refresh tokens, rotate tokens, load messages, or read the Microsoft secret table.

## Response Shape

When one active mailbox connection exists:

```json
{
  "ok": true,
  "connected": true,
  "connection": {
    "id": "...",
    "mailbox_email": "ogjewelers@hotmail.com",
    "display_name": "Otello Guillen",
    "status": "connected",
    "connected_at": "...",
    "updated_at": "...",
    "last_successful_check_at": "...",
    "last_error_code": null,
    "last_error_at": null,
    "access_token_expires_at": "...",
    "scopes": ["Mail.Read", "User.Read"],
    "tenant_id_or_authority": "https://login.microsoftonline.com/consumers"
  }
}
```

When no active mailbox connection exists:

```json
{
  "ok": true,
  "connected": false,
  "connection": null
}
```

If more than one active connection exists, the function returns:

```json
{
  "ok": false,
  "error": "multiple_active_connections"
}
```

## Safe Fields Returned

The function returns only safe metadata from `public.microsoft_mailbox_connections`:

- `id`
- `mailbox_email`
- `display_name`
- `status`
- `connected_at`
- `updated_at`
- `last_successful_check_at`
- `last_error_code`
- `last_error_at`
- `access_token_expires_at`
- `scopes`
- `tenant_id_or_authority`

The active connection definition matches Step 3.5D.4:

```text
connected
error
reconnect_required
```

Rows with `status = disconnected` do not count as active and are not returned by this endpoint.

## Security Boundary

The function requires:

- a valid Supabase Auth bearer token
- an active `employees` row
- `role = admin`

It uses the service-role Supabase client only inside the Edge Function. Browser clients do not query the mailbox tables directly through this endpoint.

The function does not return:

- `refresh_token_ciphertext`
- `refresh_token_iv`
- `refresh_token_key_version`
- access tokens
- refresh tokens
- Microsoft client secrets
- raw Microsoft OAuth payloads
- raw Microsoft Graph payloads
- the `metadata` JSON column

`supabase/config.toml` includes the function with `verify_jwt = true`.

## Safe Error Codes

The function returns short safe errors only:

- `admin_required`
- `unauthorized`
- `configuration_error`
- `status_lookup_failed`
- `multiple_active_connections`
- `unexpected_status_error`

Database internals, token details, raw error bodies, and secrets are not returned.

## Deploy

Deploy this function with:

```bash
npx supabase functions deploy microsoft-mailbox-status --project-ref byhytmarmigalvawkedi
```

No database migration is needed for this step if the Step 3.5D.2 migration has already been applied.

No new environment variable is needed. The function uses the existing:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

## Test With Browser DevTools

For local static app testing, start the static server:

```bash
python3 -m http.server 3000
```

Open:

```text
http://127.0.0.1:3000/email-triage.html
```

Sign in as an active admin, then run this in the browser DevTools console:

```js
const { data } = await window.supabase.auth.getSession();
const response = await fetch(`${window.SUPABASE_URL}/functions/v1/microsoft-mailbox-status`, {
  method: "GET",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: window.SUPABASE_ANON_KEY
  }
});
await response.json();
```

Expected active-admin result when the mailbox is connected:

```json
{
  "ok": true,
  "connected": true,
  "connection": {
    "id": "...",
    "mailbox_email": "...",
    "display_name": "...",
    "status": "connected",
    "connected_at": "...",
    "updated_at": "...",
    "last_successful_check_at": "...",
    "last_error_code": null,
    "last_error_at": null,
    "access_token_expires_at": "...",
    "scopes": ["..."],
    "tenant_id_or_authority": "..."
  }
}
```

Confirm no token fields are present in the response.

## Test With Curl

From an authenticated browser session, copy the Supabase access token from DevTools:

```js
(await window.supabase.auth.getSession()).data.session.access_token
```

Then run:

```bash
curl -i \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>" \
  -H "apikey: <SUPABASE_ANON_KEY>" \
  https://byhytmarmigalvawkedi.supabase.co/functions/v1/microsoft-mailbox-status
```

Expected:

- active admin receives `200` with `connected=true` and safe mailbox metadata
- anonymous request receives `401` with `unauthorized`
- non-admin authenticated request receives `403` with `admin_required`
- no token fields are returned

## Intentionally Deferred

This step does not implement:

- Step 3.5D.7 UI status reading or auto-load cleanup
- Step 3.5D.6 disconnect or reconnect controls
- Microsoft Graph message loading changes
- OAuth callback changes
- latest-message token-flow changes
- email persistence tables
- AI classification
- Outlook drafts, sending, or category changes
- background sync or cron jobs
- Step 4 behavior

## Next Recommended Step

Proceed to Step 3.5D.7 after approval: update `email-triage.html` and `email-triage.js` so the UI reads `microsoft-mailbox-status` on load, displays persisted connection state, and can auto-load messages when `connected=true`.
