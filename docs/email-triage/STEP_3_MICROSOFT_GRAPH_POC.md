# Step 3 - Microsoft Graph Proof Of Connection

This proof keeps the current repo shape: static admin HTML/CSS/JS in the repo root, with Microsoft OAuth and Graph access handled by Supabase Edge Functions.

## Files

- `email-triage.html`
- `email-triage.css`
- `email-triage.js`
- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`

`admin-nav.js` includes the admin-only `Email Triage` navigation item. Worker navigation does not include it.

`supabase/config.toml` marks `microsoft-auth-callback` with `verify_jwt = false` because Microsoft redirects to that function without a Supabase Authorization header. The callback still validates the signed OAuth `state` and confirms the original Supabase user is an active admin before exchanging the code.

## Required Supabase Secrets

Set these as Supabase Edge Function secrets. Do not put these in browser JavaScript, HTML, localStorage, sessionStorage, or committed files.

```env
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=
MICROSOFT_REDIRECT_URI=
MICROSOFT_GRAPH_SCOPES=offline_access Mail.Read User.Read
MICROSOFT_AUTHORITY_HOST=https://login.microsoftonline.com
MICROSOFT_GRAPH_BASE_URL=https://graph.microsoft.com/v1.0
```

The functions also require the existing Supabase server-side secrets:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

For hosted Supabase:

```bash
npx supabase secrets set MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... MICROSOFT_TENANT_ID=... MICROSOFT_REDIRECT_URI=...
```

For local functions, place local-only values in a Supabase env file that is ignored by `supabase/.gitignore`, then run functions with that env file.

## Redirect URI

Register the exact callback URL in Microsoft Entra ID. For hosted Supabase it should be:

```text
https://<project-ref>.supabase.co/functions/v1/microsoft-auth-callback
```

For local Supabase functions it is usually:

```text
http://127.0.0.1:54321/functions/v1/microsoft-auth-callback
```

`MICROSOFT_REDIRECT_URI` must match the registered value exactly.

## Local Run

Serve the static app with any simple static server from the repo root, for example:

```bash
python3 -m http.server 3000
```

Run Supabase locally if you are testing local Edge Functions:

```bash
npx supabase start
npx supabase functions serve --env-file supabase/.env.local
```

Then open:

```text
http://127.0.0.1:3000/email-triage.html
```

## Test Checklist

1. Sign in as an active admin user.
2. Open `email-triage.html`.
3. Confirm non-admin users redirect to `worker-dashboard.html`.
4. Click `Connect Outlook Mailbox`.
5. Confirm Microsoft login opens.
6. Confirm Microsoft redirects to `microsoft-auth-callback`.
7. Confirm the page returns with `outlook=connected`.
8. Confirm the latest 10 sanitized Outlook emails render.
9. Inspect browser payloads and confirm no Microsoft client secret, raw access token, or refresh token is returned in JSON or page markup.

## Security Notes

- The OAuth code exchange happens only in `microsoft-auth-callback`.
- The browser receives only a short-lived, encrypted, HttpOnly proof cookie for this no-database-write proof.
- `microsoft-latest-messages` validates the Supabase session and active admin role before using that proof cookie.
- The Graph response is reduced to `id`, `subject`, `from`, `receivedDateTime`, and `bodyPreview`.
- The functions log only safe status, sanitized errors, and message counts.
