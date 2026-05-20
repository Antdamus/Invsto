# Step 3.5D.3 OAuth Callback Persistence

Date: 2026-05-20

## What Changed

`supabase/functions/microsoft-auth-callback/index.ts` now persists the Microsoft mailbox connection after a successful OAuth callback.

The callback still:

- validates the signed OAuth `state`
- verifies the original Supabase user is an active admin
- exchanges the authorization code server-side
- sets the existing short-lived encrypted HttpOnly proof cookie
- redirects back to `EMAIL_TRIAGE_APP_URL` with `outlook=connected`

It now also:

- requires a Microsoft `refresh_token` in the token response
- calls Microsoft Graph `/me` server-side
- stores safe mailbox metadata in `public.microsoft_mailbox_connections`
- encrypts the refresh token with Edge Function Web Crypto AES-GCM
- stores only ciphertext, IV, and key version in `public.microsoft_mailbox_connection_secrets`
- fails with safe redirect reason codes such as `missing_refresh_token`, `missing_token_encryption_key`, `graph_me_failed`, `connection_upsert_failed`, `secret_upsert_failed`, or `different_mailbox_already_connected`

The refresh token is never logged, returned to browser JavaScript, or stored in plaintext.

## Required New Env Vars

Add these Supabase Edge Function secrets:

```env
MICROSOFT_TOKEN_ENCRYPTION_KEY=
MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION=v1
```

Keep all existing Microsoft and Supabase function secrets from Step 3.

## Generate A Safe Encryption Key

Generate a random 32-byte key and store the base64 output as the env var value:

```bash
openssl rand -base64 32
```

Add it to `supabase/.env.microsoft.local`:

```env
MICROSOFT_TOKEN_ENCRYPTION_KEY=<output-from-openssl>
MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION=v1
```

Do not commit this file. It is ignored by the existing Supabase env ignore pattern.

## Upload Secrets

```bash
npx supabase secrets set --env-file supabase/.env.microsoft.local --project-ref byhytmarmigalvawkedi
```

## Redeploy Function

Only the callback function needs to be redeployed for this step:

```bash
npx supabase functions deploy microsoft-auth-callback --project-ref byhytmarmigalvawkedi
```

## Test

From the repo root, run the local static server:

```bash
python3 -m http.server 3000
```

Open:

```text
http://127.0.0.1:3000/email-triage.html
```

Reconnect Outlook through the page.

Expected browser result:

```text
http://127.0.0.1:3000/email-triage.html?outlook=connected
```

The existing latest-message proof path should still load the latest 10 sanitized message previews.

Verify in Supabase:

- `public.microsoft_mailbox_connections` has one row for the connected mailbox
- `public.microsoft_mailbox_connection_secrets` has one row for that connection
- `refresh_token_ciphertext`, `refresh_token_iv`, and `refresh_token_key_version` are populated
- no plaintext refresh token is visible
- no access token is persisted, only `access_token_expires_at`

## Single-Mailbox MVP Behavior

The callback checks for an existing active mailbox where status is `connected`, `error`, or `reconnect_required`.

If the OAuth callback identifies a different mailbox than the active one, it fails safely with:

```text
different_mailbox_already_connected
```

This preserves the current one-active-mailbox MVP behavior enforced by the schema.

## Intentionally Deferred

This step does not implement:

- persistent refresh-token usage in `microsoft-latest-messages`
- mailbox status or health Edge Function
- disconnect or reconnect controls
- admin UI connection management
- email message persistence
- AI classification
- drafts, sending, or Outlook category updates
- background sync or cron jobs
- production GitHub Pages redirect changes

`microsoft-latest-messages` still uses the temporary short-lived proof cookie. Switching it to decrypt stored refresh tokens is Step 3.5D.4.
