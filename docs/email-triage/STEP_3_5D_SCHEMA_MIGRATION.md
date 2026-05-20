# Step 3.5D Schema Migration

Date: 2026-05-20

## Migration Created

- `supabase/migrations/20260520103000_email_triage_microsoft_mailbox_connections.sql`

## Tables Created

### `public.microsoft_mailbox_connections`

Stores non-secret Microsoft mailbox connection metadata only:

- mailbox identity fields such as `mailbox_email`, `microsoft_user_id`, and `display_name`
- Supabase admin actor fields such as `connected_by` and `disconnected_by`
- connection status and health metadata
- OAuth scope and tenant/authority metadata
- safe JSON metadata

This table intentionally does not contain access tokens, refresh tokens, encrypted refresh-token material, IVs, key versions, or raw Microsoft OAuth responses.

### `public.microsoft_mailbox_connection_secrets`

Stores encrypted refresh-token material only:

- `refresh_token_ciphertext`
- `refresh_token_iv`
- `refresh_token_key_version`
- refresh-token rotation and expiry metadata

This table is designed for Supabase Edge Function service-role access only. Browser clients must not query it directly.

## Constraints And Indexes

- `microsoft_mailbox_connections.status` is constrained to:
  - `connected`
  - `disconnected`
  - `error`
  - `reconnect_required`
- `microsoft_user_id` is unique.
- `lower(mailbox_email)` has a unique functional index.
- A partial unique index enforces one active OG mailbox MVP connection where status is `connected`, `error`, or `reconnect_required`.
- Supporting indexes were added for status lookup, connected-by audit lookup, and refresh-token rotation ordering.

## RLS And Grants Summary

### `public.microsoft_mailbox_connections`

- RLS is enabled.
- Access is revoked from `public`, `anon`, and `authenticated` before explicit grants.
- `authenticated` receives `select` only.
- The only browser-facing policy allows select for active admins, using `public.is_admin()` plus an `employees.active = true` admin row check.
- No browser insert, update, or delete policy is created.
- `service_role` receives select, insert, update, and delete for future Edge Function persistence.

### `public.microsoft_mailbox_connection_secrets`

- RLS is enabled.
- Access is revoked from `public`, `anon`, and `authenticated`.
- No browser-facing policies are created.
- `service_role` receives select, insert, update, and delete.

## Updated At Behavior

Both tables use the existing `public.set_updated_at()` trigger convention:

- `trg_microsoft_mailbox_connections_updated_at`
- `trg_microsoft_mailbox_connection_secrets_updated_at`

## Security Boundary

The schema keeps the Step 3 security boundary:

- browser-visible metadata is separated from encrypted token material
- no plaintext token column exists
- no raw Microsoft OAuth token response is stored
- no policy exposes the secrets table to browser clients
- future token encryption/decryption remains an Edge Function responsibility

## Intentionally Not Implemented Yet

This step does not implement:

- OAuth callback persistence
- refresh-token encryption helpers
- persistent Graph session refresh
- mailbox status Edge Function
- disconnect or reconnect behavior
- admin UI connection controls
- email ingestion tables
- AI classification
- drafts, sending, or Outlook category updates
- background sync workers

## Next Recommended Prompt

Proceed with Step 3.5D.3 only after approval:

Update `supabase/functions/microsoft-auth-callback/index.ts` so that after a successful Microsoft OAuth token exchange it encrypts the refresh token server-side, writes safe metadata to `public.microsoft_mailbox_connections`, writes encrypted refresh-token material to `public.microsoft_mailbox_connection_secrets`, preserves the current proof-of-connection behavior, and never logs or exposes plaintext token material.
