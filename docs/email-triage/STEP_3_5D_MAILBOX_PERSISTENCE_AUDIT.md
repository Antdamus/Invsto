# Step 3.5D - Persistent Mailbox Connection Audit

Date: 2026-05-20

## Executive Summary

Step 3 proved Microsoft Graph connectivity without database writes by keeping Microsoft tokens in server-side Edge Functions and a short-lived encrypted HttpOnly proof cookie. Step 3.5D should keep that security boundary and add persistence only after approval.

Recommended design:

- Keep the MVP single-mailbox for the OG Hotmail/Outlook account.
- Store non-secret connection metadata in `public.microsoft_mailbox_connections`.
- Store refresh-token material separately in `public.microsoft_mailbox_connection_secrets`, with no browser-facing grants or RLS policies.
- Encrypt refresh tokens before writing them, using an Edge Function-only key such as `MICROSOFT_TOKEN_ENCRYPTION_KEY`.
- Do not persist access tokens unless there is a proven need; refresh in memory when `microsoft-latest-messages` runs.
- Expose connection status through a new Edge Function response, never by direct browser reads of token rows.

This repo does not currently show an established Supabase Vault or token-encryption pattern. `pgcrypto` exists in migrations, but only as an extension used around UUID generation, not as a project convention for secret storage. Supabase Vault can be reconsidered if it is confirmed enabled in the hosted project, but the lowest-friction repo-aligned MVP is an encrypted secret column in a service-role-only table.

## Current Step 3 Architecture Recap

The current proof matches the Step 2 audit recommendation:

- Static frontend files:
  - `email-triage.html`
  - `email-triage.js`
  - `email-triage.css`
- Supabase Edge Functions:
  - `microsoft-auth-start`
  - `microsoft-auth-callback`
  - `microsoft-latest-messages`
- Existing admin/auth helpers:
  - `initSupabase.js`
  - `auth.js`
  - `admin-nav.js`

Current behavior:

- Browser session is Supabase Auth.
- Browser calls `microsoft-auth-start` with a Supabase access token.
- `microsoft-auth-start` validates active admin status, signs OAuth `state`, and returns the Microsoft authorization URL.
- `microsoft-auth-callback` has `verify_jwt = false` because Microsoft cannot send a Supabase JWT, then validates signed state and active admin status before exchanging the code.
- `microsoft-auth-callback` currently fetches latest messages as proof and writes only a short-lived encrypted HttpOnly cookie.
- `microsoft-latest-messages` validates the Supabase admin session, decrypts the proof cookie, calls Graph, and returns sanitized message fields only.

No current Step 3 code writes Microsoft tokens or Graph message payloads to Postgres.

## Repo Findings Relevant To Persistence

Reviewed source-of-truth and implementation files:

- `docs/email-triage/EMAIL_TRIAGE_REPO_AUDIT.md`
- `docs/email-triage/STEP_3_MICROSOFT_GRAPH_POC.md`
- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`
- `supabase/config.toml`
- `email-triage.html`
- `email-triage.js`
- `email-triage.css`
- `admin-nav.js`
- `initSupabase.js`
- `auth.js`
- Supabase migrations under `supabase/migrations/`

Relevant patterns found:

- Edge Functions already use `SUPABASE_SERVICE_ROLE_KEY` for privileged server-side work.
- Admin checks currently combine Supabase Auth user lookup with `employees.role = 'admin'` and `employees.active`.
- Migrations commonly enable RLS and add explicit `authenticated` and `service_role` grants.
- `public.is_admin()` exists, but its final definition appears to read the `role` claim from the Supabase JWT.
- Several tables use audit metadata such as actor IDs, timestamps, status fields, and safe JSON metadata.
- `supabase/config.toml` has a commented `[db.vault]` section but no active Vault configuration.
- No migration uses `vault.*`, `pgsodium`, `pgp_sym_encrypt`, or `pgp_sym_decrypt`.
- `pgcrypto` is created in one migration, but there is no project pattern for using it to encrypt secrets.

## Recommended Persistence Model

Use a two-table model:

1. `public.microsoft_mailbox_connections`
   - Stores readable connection metadata and status.
   - Can be visible to active admins through RLS.
   - Contains no token material.

2. `public.microsoft_mailbox_connection_secrets`
   - Stores encrypted refresh-token material and rotation metadata.
   - Should not be readable or writable by `anon` or normal `authenticated` browser clients.
   - Should be accessed only by service-role Edge Functions.

This split avoids column-level leakage. RLS is row-oriented, not a strong column-secrecy boundary for a table that browser code can query. Keeping tokens in a separate service-role-only table is simpler and safer.

## Recommended Table Design

Recommended metadata table name:

```text
public.microsoft_mailbox_connections
```

Recommended metadata columns:

```sql
id uuid primary key default gen_random_uuid(),
mailbox_email text not null,
microsoft_user_id text not null,
display_name text,
connected_by uuid references auth.users(id) on delete set null,
connected_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
status text not null default 'connected',
scopes text[] not null default '{}',
tenant_id_or_authority text not null,
access_token_expires_at timestamptz,
last_successful_check_at timestamptz,
last_error_code text,
last_error_at timestamptz,
disconnected_at timestamptz,
disconnected_by uuid references auth.users(id) on delete set null,
metadata jsonb not null default '{}'::jsonb
```

Recommended constraints:

```sql
check (status in ('connected', 'disconnected', 'error', 'reconnect_required')),
unique (microsoft_user_id),
unique (lower(mailbox_email)) -- use a functional unique index
```

For the OG MVP, add a partial unique index that permits only one active connection:

```sql
unique where status in ('connected', 'error', 'reconnect_required')
```

Recommended secret table name:

```text
public.microsoft_mailbox_connection_secrets
```

Recommended secret columns:

```sql
connection_id uuid primary key references public.microsoft_mailbox_connections(id) on delete cascade,
refresh_token_ciphertext text not null,
refresh_token_iv text not null,
refresh_token_key_version text not null default 'v1',
refresh_token_last_rotated_at timestamptz not null default now(),
refresh_token_expires_at timestamptz,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

Do not store raw Microsoft token response JSON. Do not store refresh tokens in the metadata table.

## Recommended Token Security Approach

Recommended MVP approach:

- Encrypt refresh tokens inside Edge Functions with Web Crypto AES-GCM.
- Keep the encryption key in Supabase Edge Function secrets as `MICROSOFT_TOKEN_ENCRYPTION_KEY`.
- Store only ciphertext, IV, and key version in `microsoft_mailbox_connection_secrets`.
- Keep access tokens in memory during a request and avoid persisting them.
- Store `access_token_expires_at` as metadata only.
- Rotate the stored refresh token whenever Microsoft returns a replacement refresh token.

Why this fits the repo:

- Edge Functions already handle secrets through `Deno.env.get(...)`.
- The current proof already uses Web Crypto AES-GCM for the short-lived proof cookie.
- The repo does not currently have a Vault-backed implementation pattern.
- The token table can remain service-role-only without adding a new backend service.

Supabase Vault option:

- If the hosted Supabase project has Vault enabled and the team wants managed database-side secret storage, store the refresh token in Vault and save only a Vault secret reference on the connection record.
- Before choosing Vault, verify local development support, hosted project availability, migration behavior, and Edge Function read/write ergonomics.
- Do not block the MVP on Vault unless the project explicitly decides that database-managed secret storage is required.

Not recommended:

- Plaintext token columns.
- Browser-readable token fields.
- Token storage in `localStorage`, `sessionStorage`, HTML, markdown, or committed env files.
- Persisting access tokens by default.
- Using `pgcrypto` ad hoc unless the team chooses a DB-side encryption standard and key-management story.

## RLS And Service-Role Access Plan

`microsoft_mailbox_connections`:

- Enable RLS.
- Revoke all from `anon`.
- Grant `select` to `authenticated`.
- Admin-only select policy using `public.is_admin()`.
- Avoid direct browser insert/update/delete policies for the MVP.
- Grant `select`, `insert`, `update`, and possibly `delete` to `service_role`.

`microsoft_mailbox_connection_secrets`:

- Enable RLS.
- Revoke all from `anon` and `authenticated`.
- Do not create browser-facing policies.
- Grant only `select`, `insert`, `update`, and `delete` to `service_role`.
- Do not expose this table through frontend JS or direct Supabase browser calls.

The frontend should get connection status from an Edge Function, not by querying the secret table.

## Edge Function Changes Needed Later

`microsoft-auth-start`:

- Keep current active-admin validation.
- Continue signing state with the Supabase user ID and return URL.
- Add an action/mode later if reconnect needs special UI copy, but the OAuth flow can remain the same.
- Consider adding `prompt=select_account` for reconnect to reduce accidental wrong-mailbox authorization.

`microsoft-auth-callback`:

- Keep `verify_jwt = false`.
- Validate signed state exactly as today.
- Verify the original Supabase user is still an active admin.
- Exchange authorization code server-side.
- Call Graph `/me` to capture Microsoft account identity:
  - `id`
  - `mail`
  - `userPrincipalName`
  - `displayName`
- Normalize mailbox email from `mail` or `userPrincipalName`.
- Encrypt the refresh token in the Edge Function.
- Upsert `microsoft_mailbox_connections` by `microsoft_user_id` or normalized mailbox email.
- Upsert `microsoft_mailbox_connection_secrets` by `connection_id`.
- Set `connected_by`, `connected_at`, `status = 'connected'`, `scopes`, `tenant_id_or_authority`, and `access_token_expires_at`.
- Do not log token payloads, refresh tokens, access tokens, or raw Graph profile responses.

`microsoft-latest-messages`:

- Keep active-admin validation.
- Load the single active connection through service-role Supabase.
- Load encrypted refresh-token material from the service-role-only secret table.
- Decrypt the refresh token inside the Edge Function.
- If the access token is expired or absent, exchange the refresh token for a new access token.
- If Microsoft returns a new refresh token, re-encrypt and update the stored secret.
- Call Graph `/me/messages` with the in-memory access token.
- Return only sanitized fields to the browser.
- Update metadata:
  - `last_successful_check_at`
  - `last_error_code`
  - `last_error_at`
  - `access_token_expires_at`
  - `status`

New function recommended:

```text
microsoft-mailbox-status
```

Purpose:

- Return safe connection status for the admin UI.
- Include mailbox email, display name, connected admin, connected timestamp, last checked, status, scopes, and safe error code.
- Never return token material or raw OAuth/Graph payloads.

New function recommended later:

```text
microsoft-mailbox-disconnect
```

Purpose:

- Mark the connection disconnected.
- Delete or null encrypted refresh-token material.
- Optionally call Microsoft revoke/logout endpoints if the final Microsoft account type and revocation behavior are verified.

## Frontend Changes Needed Later

`email-triage.html` should eventually show safe metadata:

- Connected mailbox
- Connected by
- Connected at
- Last checked
- Status
- Last safe error code, if any

Buttons:

- Refresh latest emails
- Reconnect mailbox
- Disconnect mailbox

`email-triage.js` should:

- Call `microsoft-mailbox-status` on page load.
- Show connect UI if no active connection exists.
- Show reconnect UI for `error` or `reconnect_required`.
- Keep calling `microsoft-latest-messages` for sanitized latest-message previews.
- Never query the secrets table.
- Never display raw token, raw Microsoft auth, or raw token-exchange payloads.

## Reconnect Plan

Reconnect should reuse the OAuth start/callback flow:

- Admin clicks `Reconnect mailbox`.
- `microsoft-auth-start` generates a fresh authorization URL.
- Callback validates state and admin status.
- Callback exchanges the code and confirms the mailbox identity.
- If the same mailbox is returned, replace the encrypted refresh token and set `status = 'connected'`.
- If a different mailbox is returned during the single-mailbox MVP, either reject with `wrong_mailbox` or require an explicit disconnect first.

Recommended MVP behavior: prevent silently swapping to a different mailbox. A mistaken personal-account selection should not overwrite the OG mailbox connection without a clear admin action.

## Disconnect And Revoke Plan

Disconnect should be explicit and admin-only:

- Validate active admin session in an Edge Function.
- Mark `microsoft_mailbox_connections.status = 'disconnected'`.
- Set `disconnected_at` and `disconnected_by`.
- Delete the corresponding row in `microsoft_mailbox_connection_secrets`, or overwrite token ciphertext before deleting if the team wants extra cleanup.
- Clear last error fields or keep them as historical context.
- Update UI to show disconnected status.

Microsoft-side revocation:

- Treat revocation as best-effort unless tested for personal Microsoft accounts.
- The most reliable local control is deleting the stored refresh token.
- Document that the Microsoft account owner can also revoke the app consent from Microsoft account security/privacy settings.

## Multiple Mailboxes

Recommendation: defer multiple mailboxes.

The business flow is currently centered on one OG mailbox. Supporting multiple mailboxes would add UI selection, policy decisions, per-mailbox triage queues, duplicate message handling, and routing rules before the MVP needs them.

The proposed table design does not block multiple mailboxes later. It simply adds an MVP partial unique index or application rule that allows one active connection now.

## Required Environment Variables

Keep existing Step 3 variables:

```env
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=consumers
MICROSOFT_REDIRECT_URI=
MICROSOFT_GRAPH_SCOPES=offline_access Mail.Read User.Read
MICROSOFT_AUTHORITY_HOST=https://login.microsoftonline.com
MICROSOFT_GRAPH_BASE_URL=https://graph.microsoft.com/v1.0
EMAIL_TRIAGE_APP_URL=http://127.0.0.1:3000/email-triage.html
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Add later for encrypted refresh-token persistence:

```env
MICROSOFT_TOKEN_ENCRYPTION_KEY=
MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION=v1
```

The encryption key should be random, high entropy, and stored only as a Supabase Edge Function secret. Do not commit it.

No production URL switch is recommended during Step 3.5D. Keep:

```env
EMAIL_TRIAGE_APP_URL=http://127.0.0.1:3000/email-triage.html
```

until the feature branch is merged or published to the GitHub Pages branch.

## Security Risks And Mitigations

Refresh-token compromise:

- Mitigation: encrypt before storage, store only in a service-role-only table, never return to browser, avoid logs, rotate when Microsoft returns a new refresh token.

Browser querying sensitive rows:

- Mitigation: split token material into a separate table with no `authenticated` grants or policies.

Accidental wrong mailbox connection:

- Mitigation: store `microsoft_user_id` and normalized mailbox email, show the mailbox in UI, and prevent silent mailbox swaps during MVP reconnect.

Callback abuse:

- Mitigation: keep signed and expiring OAuth state, bind state to the Supabase admin user ID, and re-check active admin status in callback.

Token logging:

- Mitigation: log only phase, safe error code, status code, and counts. Never log token payloads or raw Graph message/profile payloads.

Overbroad Graph permission:

- Mitigation: use only `Mail.Read` for MVP message reading. Keep `Mail.ReadWrite` unused until a later approved draft/category phase.

PII exposure:

- Mitigation: return only sanitized previews to browser, avoid storing message bodies in Step 3.5D, and defer email-content persistence to a later approved triage phase.

Production URL mismatch:

- Mitigation: keep local `EMAIL_TRIAGE_APP_URL` until the feature branch is actually published, then switch both Supabase secret and Microsoft registered redirect behavior intentionally.

Key rotation:

- Mitigation: store key version alongside ciphertext. Later rotation can decrypt with the old key and re-encrypt with a new key in a service-role maintenance function.

## Open Questions

- Is Supabase Vault enabled and desired for this hosted project, or should Step 3.5D use Edge Function AES-GCM encrypted columns for the MVP?
- Should the MVP enforce a known mailbox allowlist such as `OGJEWELERS@hotmail.com` through an env var?
- Should admins be allowed to replace the connected mailbox without disconnecting first?
- Should disconnect attempt Microsoft-side revocation, or only delete local token material for the MVP?
- Should a small audit/event table be added in the same implementation phase to record connect, reconnect, disconnect, refresh success, and refresh failure events?
- Should the future UI show only admin `display_name`, or also admin email from Supabase Auth metadata when available?

## Recommended Implementation Phases For Step 3.5D

Phase 1 - Schema approval:

- Approve table names and two-table split.
- Decide whether to include an event/audit table now or later.
- Decide whether to enforce a configured mailbox allowlist.
- Decide encrypted-column MVP versus Supabase Vault.

Phase 2 - Migration:

- Add `microsoft_mailbox_connections`.
- Add `microsoft_mailbox_connection_secrets`.
- Enable RLS and grants.
- Add indexes and status constraints.
- Do not add Step 4 triage message/classification tables.

Phase 3 - Edge Function persistence:

- Update callback to save connection metadata and encrypted refresh token.
- Update latest-messages to refresh tokens from persisted connection state.
- Add mailbox status function.
- Add safe error/status metadata updates.

Phase 4 - Admin UI status:

- Show connected mailbox, connected by, connected at, last checked, status, reconnect, and disconnect controls.
- Continue returning only sanitized message previews.

Phase 5 - Disconnect:

- Add disconnect function.
- Delete encrypted token material and mark metadata disconnected.
- Add best-effort Microsoft-side revocation only after behavior is tested.

Stop after these phases before Step 4. AI classification, draft replies, email persistence, eBay matching, background sync, and cron jobs remain out of scope until separately approved.
