# Step 3.5D.4 Persistent Latest Messages

Date: 2026-05-20

## What Changed

`supabase/functions/microsoft-latest-messages/index.ts` now prefers the persisted Microsoft mailbox connection when loading the latest Outlook messages.

The function still requires:

- a valid Supabase Auth bearer token
- an active `employees` row
- `role = admin`

It now:

- loads the single active mailbox connection from `public.microsoft_mailbox_connections`
- loads the encrypted refresh-token row from `public.microsoft_mailbox_connection_secrets`
- decrypts the refresh token server-side with Web Crypto AES-GCM
- exchanges the refresh token for a fresh Microsoft access token
- rotates the stored encrypted refresh token if Microsoft returns a replacement
- calls Microsoft Graph `/me/messages`
- returns only sanitized message previews
- updates connection health metadata after success or failure

No plaintext refresh token, access token, client secret, raw Microsoft token response, or raw Graph message payload is returned to the browser.

## Retrieval Flow

1. Browser calls `microsoft-latest-messages` with the existing Supabase session token.
2. The Edge Function validates the user is an active admin.
3. The function looks for active mailbox connections with status:
   - `connected`
   - `error`
   - `reconnect_required`
4. If exactly one active connection exists, the function loads its encrypted refresh-token material.
5. The refresh token is decrypted using `MICROSOFT_TOKEN_ENCRYPTION_KEY`.
6. Microsoft's token endpoint is called with `grant_type=refresh_token`.
7. If Microsoft returns a new refresh token, it is encrypted and stored back in `microsoft_mailbox_connection_secrets`.
8. The fresh in-memory access token is used to fetch the latest 10 messages.
9. The response stays compatible with the current frontend:

```json
{
  "ok": true,
  "messages": [],
  "source": "persisted_connection"
}
```

## Fallback Behavior

The Step 3 proof-cookie path is still present for transition safety.

Behavior:

- persisted active connection exists: use persisted refresh-token flow
- no persisted active connection exists: fall back to the existing encrypted HttpOnly proof cookie
- no persisted connection and no proof cookie: return `mailbox_not_connected`

The fallback response may include:

```json
{
  "ok": true,
  "messages": [],
  "source": "proof_cookie"
}
```

## Safe Error Codes

The function returns short safe error codes only:

- `missing_authorization`
- `invalid_session`
- `employee_lookup_failed`
- `admin_required`
- `configuration_error`
- `connection_lookup_failed`
- `multiple_active_connections`
- `mailbox_not_connected`
- `missing_connection_secret`
- `connection_secret_lookup_failed`
- `refresh_token_decrypt_failed`
- `token_refresh_failed`
- `refresh_token_rotation_failed`
- `graph_messages_failed`
- `outlook_connection_expired`
- `outlook_connection_user_mismatch`
- `latest_messages_failed`

Token refresh and Graph logs include only safe fields such as phase, status code, Microsoft error code, and connection id. They do not log tokens or raw payloads.

## Health Metadata

On successful persisted retrieval, `public.microsoft_mailbox_connections` is updated with:

- `status = connected`
- `last_successful_check_at = now()`
- `last_error_code = null`
- `last_error_at = null`
- `access_token_expires_at` from the Microsoft token expiry when available
- `updated_at = now()`

On failure:

- missing or undecryptable secret failures set `status = reconnect_required`
- token refresh failures set `status = reconnect_required`
- Graph message failures set `status = error`
- `last_error_code`, `last_error_at`, and `updated_at` are updated

## Required Env Vars

The function requires the existing Edge Function secrets:

```env
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=consumers
MICROSOFT_GRAPH_SCOPES=offline_access Mail.Read User.Read
MICROSOFT_AUTHORITY_HOST=https://login.microsoftonline.com
MICROSOFT_GRAPH_BASE_URL=https://graph.microsoft.com/v1.0
MICROSOFT_TOKEN_ENCRYPTION_KEY=
MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION=v1
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

`MICROSOFT_REDIRECT_URI` is still required by the OAuth callback/start flow, but this latest-messages function does not use it directly.

## Redeploy

Redeploy only this function for Step 3.5D.4:

```bash
npx supabase functions deploy microsoft-latest-messages --project-ref byhytmarmigalvawkedi
```

## Test

From the repo root:

```bash
npx supabase functions deploy microsoft-latest-messages --project-ref byhytmarmigalvawkedi
python3 -m http.server 3000
```

Open:

```text
http://127.0.0.1:3000/email-triage.html
```

Expected:

- latest emails load using the persisted refresh token flow
- no Outlook reconnect is needed when a persisted connection exists
- `public.microsoft_mailbox_connections.last_successful_check_at` updates
- `public.microsoft_mailbox_connections.status` remains `connected`
- `public.microsoft_mailbox_connection_secrets.refresh_token_ciphertext` remains encrypted-looking text
- if Microsoft returns a new refresh token, ciphertext and `refresh_token_last_rotated_at` may update

## Intentionally Deferred

This step does not implement:

- mailbox status or health UI
- disconnect/reconnect controls
- admin UI connection management
- email persistence tables
- AI classification
- Outlook drafts, sending, or category updates
- background sync, cron jobs, or long-running workers
- Step 4 behavior
