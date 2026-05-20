# OG Email Triage Assistant - Step 2 Repo Audit

Date: 2026-05-19

## Executive Summary

The safest place to add Microsoft Graph Outlook integration is **Supabase Edge Functions**, paired with a small authenticated admin-only page in the existing web app for the Step 3 proof-of-connection.

This repo is currently a static HTML/CSS/JavaScript application that talks directly to Supabase from browser pages using the public anon key. Server-side secrets already live in `supabase/functions/*` via `Deno.env.get(...)`, including OpenAI, eBay, and service-role Supabase credentials. Microsoft Graph client secrets, OAuth code exchange, refresh tokens, and mailbox access should follow that server-side Edge Function pattern, not be placed in browser JavaScript.

Recommended Step 3 shape:

- Browser page: `email-triage.html` plus `email-triage.js` for the admin proof UI.
- Edge Functions: one function to start/callback Microsoft OAuth and one function to read the latest 10 messages.
- No database writes for Step 3 unless a token store is explicitly approved as part of Step 3 setup.
- Token storage, once needed, should be in a new locked-down Supabase table or Supabase Vault-backed pattern, accessed only by service-role Edge Functions.

## Current Repo Architecture

The repo is not organized as a bundled framework app. It is mostly static assets served as pages:

- Root admin/worker inventory app:
  - `index.html`, `auth.js`, `initSupabase.js`
  - `dashboard.html/js/css`
  - `worker-dashboard.html/js/css`
  - `stock.html/js/css`
  - `pending-orders.html/js/css`
  - `ebay-order-history.html/js/css`
  - `add-item.html`, `additem.js`
  - `add-inventory.html`, `add-inventory.js`
  - `admin.html`, `admin.js`, `admin-users.js`, `admin-schedule.js`, etc.
- Storefront:
  - `StoreWebsite/*`
  - `StoreWebsite/StoreCart/*`
  - `StoreWebsite/StoreAdmin/*`
  - `Join/*`
- Mobile capture app:
  - `Iphone_app/OGJewelryCapture/*`
- Backend/server-side code:
  - `supabase/functions/*`
  - `supabase/migrations/*`
- Documentation:
  - `docs/*`
  - `docs/legacy/*`

There is no current Next.js/Express backend, no app router, and no central Node service. `package.json` only lists Supabase CLI as a dev dependency.

## Current Supabase/Database Architecture

Supabase is the backend of record. The repo contains:

- `supabase/config.toml`
- many SQL migrations under `supabase/migrations/`
- Deno Edge Functions under `supabase/functions/`

The base schema is represented in `supabase/migrations/20260124184912_remote_schema.sql`, with many later migrations adding inventory, storefront, capture, timeclock, payroll, eBay order, and audit behavior.

Important tables and concepts already present:

- Employees/auth:
  - `employees`
  - Supabase Auth users
  - role fields such as `admin` and `employee`
  - helper functions/policies such as `public.is_admin()` and `public.can_manage_inventory()`
- Inventory:
  - `item_types`
  - `item_stock_locations`
  - `locations`
  - `stock_transactions`
  - `bulk_batches`
  - `metadata`
  - `inventory_change_log`
  - `photo_deletion_log`
  - `change_reversion_log`
- Sales/orders:
  - `sales`
  - `sale_items`
  - `sale_item_categories`
- eBay orders:
  - `ebay_orders`
  - `ebay_order_lines`
  - `ebay_order_admin_events`
  - `ebay_order_revert_events`
  - `ebay_order_label_events`
  - `ebay_reviews`
  - `ebay_review_sync_runs`
- Capture workflow:
  - `capture_stations`
  - `capture_jobs`
  - `capture_job_photos`
  - storage buckets such as `capture-photos` and `InventoryUpload`

## Existing Relevant Files And Folders Reviewed

Primary architecture/auth/env files:

- `package.json`
- `initSupabase.js`
- `auth.js`
- `admin-nav.js`
- `supabase/config.toml`
- `supabase/.gitignore`

Primary app surfaces reviewed:

- `dashboard.html`
- `dashboard.js`
- `pending-orders.html`
- `pending-orders.js`
- `ebay-order-history.html`
- `ebay-order-history.js`
- `stock.html`
- `stock.js`
- `additem-assisted.js`

Primary Edge Functions reviewed:

- `supabase/functions/ebay-feedback-sync/index.ts`
- `supabase/functions/generate-inventory-copy/index.ts`
- `supabase/functions/process-inventory-image/index.ts`
- `supabase/functions/list-inventory-upload-images/index.ts`
- `supabase/functions/og_send_magic_link/index.ts`
- `supabase/functions/storefront-catalog/index.ts`
- `supabase/functions/storefront-content/index.ts`
- `supabase/functions/storefront-testimonials/index.ts`

Primary migrations reviewed:

- `supabase/migrations/20260124184912_remote_schema.sql`
- `supabase/migrations/20260515090000_ebay_pending_orders_worker_checkout.sql`
- `supabase/migrations/20260514144500_worker_capture_permissions.sql`
- `supabase/migrations/20260314123000_ebay_reviews_homepage.sql`
- `supabase/migrations/20260515124500_admin_ebay_order_closeout.sql`
- `supabase/migrations/20260515133000_admin_ebay_order_reverts.sql`
- `supabase/migrations/20260517125000_worker_no_inventory_order_completion.sql`
- `supabase/migrations/20260517131000_batch_no_inventory_order_completion.sql`
- `supabase/migrations/20260517134000_no_inventory_order_evidence_repository.sql`
- `supabase/migrations/20260518165000_ebay_shipping_label_attachments.sql`
- `supabase/migrations/20260518184500_ebay_label_attachment_audit.sql`
- `supabase/migrations/20260519113000_ebay_label_tracking_metadata_indexes.sql`
- `supabase/migrations/20260519133000_extra_ebay_shipping_labels.sql`

## Frontend Structure

The frontend is page-based static HTML with page-specific JavaScript and CSS. Pages load Supabase from `initSupabase.js` and commonly rely on a `supabase-ready` event.

Authentication and role routing are browser-side:

- `auth.js` signs in with Supabase Auth.
- It reads `employees.role` and `employees.active`.
- Admins route to `dashboard.html`.
- Employees route to `worker-dashboard.html`.

Navigation is partly duplicated in HTML, but `admin-nav.js` also provides role-aware nav generation for admin and worker roles.

For Step 3, a small static admin page fits the current frontend style better than introducing a new web framework.

## Backend Structure

The repo's backend logic is Supabase:

- SQL migrations define tables, policies, RPCs, triggers, and grants.
- Edge Functions provide server-side API and third-party integration points.
- Existing functions use Deno and `Deno.env.get(...)`.
- Service-role operations are already isolated in Edge Functions.

There is no separate long-running backend worker or Node/TypeScript server in the repo today.

## Existing Environment Variable Patterns

Browser-side Supabase config is currently hardcoded in:

- `initSupabase.js`
- `StoreWebsite/initSupabase.js`
- `StoreWebsite/StoreAdmin/initSupabase.js`
- `Join/initSupabase.js`
- `testground/initSupabase.js`
- `Iphone_app/OGJewelryCapture/OGJewelryCapture/Configuration/SupabaseConfig.plist`

The key exposed there is the Supabase anon key, which is expected to be public when RLS is correct. This pattern is **not acceptable** for Microsoft Graph client secrets or refresh tokens.

Server-side secrets use `Deno.env.get(...)` inside Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_IMAGE_MODEL`
- `EBAY_APP_ID`
- `EBAY_DEV_ID`
- `EBAY_CERT_ID`
- `EBAY_AUTH_TOKEN`
- `EBAY_SITE_ID`
- `EBAY_COMPATIBILITY_LEVEL`
- `EBAY_SELLER_USER_ID`
- `METALSDEV_API_KEY`

`supabase/.gitignore` ignores local Supabase env files:

- `.env.keys`
- `.env.local`
- `.env.*.local`

There is no root `.gitignore` currently visible, so any future root `.env` file would be risky unless ignore rules are added first.

## Existing Authentication Patterns

Current app auth is Supabase Auth plus an `employees` table:

- Login uses `supabase.auth.signInWithPassword`.
- Session persistence and refresh are handled by Supabase JS in the browser.
- Role/active checks query `employees`.
- Server-side privileged functions use `SUPABASE_SERVICE_ROLE_KEY`.
- RLS policies use helper functions such as `public.is_admin()` and `public.can_manage_inventory()`.

Microsoft OAuth should be treated as an external mailbox connection owned by the business/admin workflow, not as a replacement for Supabase Auth.

## Current Database/Migration Organization

Migrations are timestamped SQL files under `supabase/migrations/`. The project already uses migrations for:

- new tables
- RLS policies
- grants
- RPC functions
- triggers
- indexes
- audit logs

If/when email triage tables are approved, they should be added as a new timestamped migration in this folder, following the same pattern.

Do not add email triage tables in Step 2. For Step 3 proof-of-connection, avoid database writes unless token persistence is explicitly included in the approval.

## Existing Inventory, Order, Listing, Customer, And eBay Data

Inventory exists:

- `item_types` stores jewelry item metadata, barcodes, descriptions, photos, weights, costs, prices, categories, and related fields.
- `item_stock_locations` tracks quantity by location and batch.
- `locations` stores physical storage/tray/location metadata.
- `stock_transactions` and audit tables preserve inventory movement/change history.

Order and sales data exists:

- `sales`
- `sale_items`
- `sale_item_categories`
- `ebay_orders`
- `ebay_order_lines`

eBay-related data exists:

- `ebay_orders` stores order-level buyer and shipping/payment metadata.
- `ebay_order_lines` stores per-line eBay item information and internal fulfillment links.
- `ebay_reviews` stores eBay feedback/testimonial data.
- `ebay_order_label_events` and label metadata migrations track shipping labels and evidence.
- `tools/ebay-og-order-link-extension/*` contains a browser extension related to eBay order/label capture.
- `ebayExport.js` and `ebayExportbracelet.js` support eBay listing exports.

Customer/member data exists, but it is not the same as eBay buyer records:

- `members` exists for the storefront join/profile flow.
- `ebay_orders` includes buyer fields: `buyer_username`, `buyer_name`, `buyer_email`.
- There does not appear to be a normalized customer table that unifies storefront members, eBay buyers, and order history.

## Current Capture Tables And Future Email Triage

The capture system is useful as an architectural precedent, not as a direct email model.

Relevant capture tables:

- `capture_stations`
- `capture_jobs`
- `capture_job_photos`

Useful patterns for email triage:

- job/status style records
- operator/admin ownership fields
- storage references instead of large payloads in UI code
- RLS policies based on inventory/admin helpers
- evidence/audit trails for sensitive workflow actions

Email triage should not reuse capture tables. It should eventually get its own domain tables, for example mailbox connections, email messages, triage classifications, linked orders/items, and draft reply records. Those should be introduced only after the proof-of-connection is approved and token-storage choices are finalized.

## Recommended Implementation Location

Recommended approach:

1. **Supabase Edge Functions for Microsoft Graph OAuth and Graph API calls**
2. **Existing static web app page for the Step 3 admin proof UI**
3. **Future Supabase tables for token metadata and triage records**

Why Edge Functions:

- Existing repo pattern for third-party secrets.
- Supports `Deno.env.get(...)`.
- Can use service-role Supabase access securely.
- Avoids exposing `MICROSOFT_CLIENT_SECRET` in browser JavaScript.
- Avoids introducing a separate backend/runtime before there is a need.

Why an existing web app route/page:

- The current app is static HTML pages, not a router-based framework.
- Admin and worker navigation already lives in this app.
- The proof-of-connection is UI-oriented: login, callback result, and display latest 10 emails.

Not recommended for Step 3:

- Frontend-only OAuth token exchange, because it would expose client secret/token handling.
- Separate Node/TypeScript service, because the repo does not currently run one.
- Backend worker, because the Step 3 task is interactive proof-of-connection, not scheduled ingestion.
- AI classification, drafts, or database writes, because they are explicitly outside Step 3.

## Best Place To Add Microsoft Graph OAuth Code

Use new Edge Functions under `supabase/functions/`, for example:

- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`

Alternatively, combine the auth endpoints into one function with path/action routing, but separate small functions match the current repo's simple function-per-purpose style.

The browser page should only call these functions or navigate to the Microsoft authorization URL. It should never hold the client secret.

## Best Place To Store Microsoft Graph Tokens Securely

For Step 3, the safest option is to avoid long-term storage if possible:

- Exchange the code server-side.
- Read latest 10 messages.
- Return a sanitized response to the authenticated admin page.
- Do not persist messages.
- Do not persist tokens unless needed for the chosen OAuth flow.

For future phases requiring refresh/offline access, add a locked-down token store:

- A new table such as `microsoft_mailbox_connections` or `email_mailbox_connections`.
- RLS should prevent normal browser reads of token material.
- Only service-role Edge Functions should read/write encrypted token fields.
- Store mailbox/account metadata separately from secret tokens.
- Consider Supabase Vault or `pgcrypto` encryption for refresh tokens.
- Track token provenance and rotation metadata: `connected_by`, `connected_at`, `expires_at`, `scopes`, `tenant_id`, `mailbox_user_id`, `last_refresh_at`.

Do not store Microsoft tokens in:

- frontend JavaScript
- localStorage
- browser sessionStorage
- markdown docs
- committed env files
- normal public-readable tables

## Recommended Environment Variable Names

Use the provided names:

```env
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=
MICROSOFT_REDIRECT_URI=http://localhost:3000/auth/microsoft/callback
```

Additional future-safe names to consider:

```env
MICROSOFT_GRAPH_SCOPES=offline_access Mail.Read Mail.ReadWrite User.Read
MICROSOFT_AUTHORITY_HOST=https://login.microsoftonline.com
MICROSOFT_GRAPH_BASE_URL=https://graph.microsoft.com/v1.0
```

For local Supabase functions, use Supabase secrets or local env files already ignored under `supabase/.gitignore`. Do not create or commit these values in this audit phase.

## Recommended Step 3 Proof-Of-Connection Plan

Goal: Microsoft login, OAuth callback, get access token, read latest 10 Outlook emails, display sender, subject, received time, and bodyPreview.

Plan:

1. Add an admin-only static page such as `email-triage.html` with matching `email-triage.js` and optional `email-triage.css`.
2. Add a nav entry only for admin users after the page exists.
3. Add an Edge Function to generate the Microsoft authorization URL using server-side env vars.
4. Add an OAuth callback handler that exchanges `code` for an access token server-side.
5. Add a latest-messages Edge Function that calls:

```http
GET https://graph.microsoft.com/v1.0/me/messages?$top=10
```

6. Return only sanitized fields to the browser:
   - sender name/email
   - subject
   - receivedDateTime
   - bodyPreview
   - Microsoft message id for proof/debug only
7. Add no AI classification.
8. Add no database writes, unless token persistence is explicitly approved.
9. Add no drafts, sends, Outlook categories, or eBay API integration.
10. Verify by running the local app and confirming the latest 10 emails render.

## Risks And Security Considerations

- `MICROSOFT_CLIENT_SECRET` must never be committed or exposed to the browser.
- Microsoft refresh tokens are high-value secrets and should be encrypted or Vault-backed if persisted.
- `Mail.ReadWrite` is already consented, but Step 3 should only read messages.
- The app must not send email automatically.
- The app must not create drafts or mutate Outlook state until a later approved phase.
- The callback flow needs CSRF protection using a `state` value.
- The callback should bind the Microsoft connection to an authenticated Supabase admin session.
- Local redirect URI and production redirect URI must both be registered in Microsoft Entra before production use.
- Email body previews may contain buyer PII, so logs should avoid dumping full Graph payloads.
- The root repo currently lacks a root `.gitignore`; create one before adding any root-level `.env` convention.
- The existing frontend has hardcoded Supabase anon keys. That is normal for Supabase anon usage but should not be copied for Graph secrets.

## Questions And Blockers Before Implementation

- What exact URL will serve the local static app for Step 3: `http://localhost:3000`, another local server, or direct file serving?
- Is the Microsoft redirect URI already registered exactly as `http://localhost:3000/auth/microsoft/callback`?
- Should Step 3 persist tokens, or should it perform a no-persistence proof in one browser session?
- Is the connected mailbox always the single OG Hotmail/Outlook mailbox, or will multiple mailboxes/users be supported later?
- Should only admins be allowed to connect/read mailbox data, or can inventory staff view triage results later?
- Should future email/order matching use `buyer_email`, `buyer_username`, order number, eBay item number, or all of these?
- Should future storage normalize eBay buyers into a dedicated customer table, or keep buyer data order-scoped?

## Final Recommendation

Proceed to Step 3 with **Supabase Edge Functions plus a small admin-only static proof page**.

Do not introduce a separate backend service yet. Do not place Microsoft OAuth code in browser-only JavaScript beyond UI actions. Do not add email triage database tables until after the proof-of-connection confirms the OAuth flow and the team decides how refresh tokens should be stored.

The first implementation should prove only:

- Microsoft login
- OAuth callback
- server-side token exchange
- server-side Graph read
- display of latest 10 messages

Everything beyond that should wait for explicit approval after this audit gate.
