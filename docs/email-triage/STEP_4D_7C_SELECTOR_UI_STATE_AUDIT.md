# Step 4D.7C - Draft Selector / UI State Drift Audit

Audit timestamp: 2026-05-23 13:24 EDT

## Diagnosis

Local code contains the Step 4D.7A/4D.7B draft-current preservation changes, but the selector and UI state risks are not fully closed.

The backend now only makes a newly inserted response draft current when `validationStatus === "valid"`. Invalid and error drafts are inserted with `is_current = false`, `superseded_at` set, and response metadata that reports preservation:

- response fields: `draft_became_current`, `previous_current_draft_preserved`
- metadata operation fields: `attempted_draft_became_current`, `previous_current_preserved`

That prevents new `safe_fallback_validation_failed`, malformed JSON, or invalid draft attempts from displacing a valid current draft.

The remaining risk is selector drift plus historical data drift:

- `admin_draft_view` filters by `message_id` whenever `messageId` is supplied, even when `classificationId` is also supplied.
- `admin_draft_view` orders `is_current desc`, then `draft_version desc`, so any old invalid/error row that is still marked current can still be returned first.
- `operator_match_context` uses `latestValidationForMessage()`, which also selects only `message_id + is_current = true`.
- regenerate/review paths validate the selected `classificationId` against `draftId`, and can still throw `response_draft_classification_mismatch` if the UI-selected classification differs from the current draft returned by message-level draft selection.
- UI action errors are message-scoped in `draftActionErrorsByMessageId`, not classification-scoped or draft-scoped.

## Live Verification Performed

Local source verification:

- `supabase/functions/microsoft-email-classify/index.ts` SHA-256: `d0a24b644b9e887edf44b1e66ce2157b2dfba24bf0ac64fe040a098cc9d4934a`
- `email-triage.js` SHA-256: `053438ca3d7c4a30816e7481e920e40511f659faf8dceaa842f85b27c46dc8ef`
- `email-triage.css` SHA-256: `9a82b6cc284299e1ef4991bde10dd50273c24a1ee90157e94d490919ed7709d8`

Deployed function reachability:

- `https://byhytmarmigalvawkedi.supabase.co/functions/v1/microsoft-email-classify` is reachable.
- A read-only unauthenticated `HEAD` returned `401` with `sb-project-ref: byhytmarmigalvawkedi` and `x-served-by: supabase-edge-runtime`.
- A read-only `admin_draft_view` POST using only the public anon key returned the function-level JSON auth failure:
  - `ok: false`
  - `error: unauthorized`
  - `mode: unknown`

Supabase deployment metadata:

- `supabase functions list` could not be used because `SUPABASE_ACCESS_TOKEN` is not available in this workspace.
- Therefore, I could not confirm the deployed function source hash or deployed bundle contents from the Supabase management API.

Browser/UI cache verification:

- A local static server was started for `email-triage.html`.
- The browser loaded `email-triage.js` from the local server with HTTP `200`.
- The browser/server log showed `email-triage.css` served as HTTP `304` from browser cache on first load.
- Direct localhost header/hash checks confirmed the server-visible assets match local files:
  - `email-triage.js`: `Content-Length: 126109`, hash `053438ca3d7c4a30816e7481e920e40511f659faf8dceaa842f85b27c46dc8ef`
  - `email-triage.css`: `Content-Length: 36253`, hash `9a82b6cc284299e1ef4991bde10dd50273c24a1ee90157e94d490919ed7709d8`
- Because the browser had no authenticated Supabase session on `http://127.0.0.1:8765`, the app redirected to login and I could not perform the selected-email UI workflow.

## API Outputs Checked

Completed:

- deployed endpoint unauthenticated reachability
- deployed endpoint anon-key auth rejection
- local source-level response shape verification

Blocked:

- `admin_draft_view` for `4effe1f7-2f82-4a86-b8c4-94e986267986`
- `operator_match_context` for the same message
- `regenerate_response` for the same message
- comparison cases for no deterministic match, return request, and item-not-as-described

Reason: the Edge Function calls `requireAdmin()` before mode dispatch. It requires a real Supabase user access token whose `employees.role` is admin. No admin browser session or `SUPABASE_ACCESS_TOKEN` was available in this workspace.

## UI Behavior Observed

The requested authenticated workflow could not be reproduced:

1. Open `email-triage.html`
2. Select problematic email
3. Click Refresh Drafts
4. Click Regenerate Draft
5. Observe banners/body/context panel

Observed instead:

- local page redirects to `index.html?next=email-triage.html`
- no Supabase auth/session keys exist in localStorage or sessionStorage for the local origin
- the browser is at the login page, so draft UI state could not be exercised

Cache finding:

- Browser cache can absolutely serve stale assets in this setup because static HTML references `email-triage.js` and `email-triage.css` without version query strings or content-hashed filenames.
- In the local verification, `email-triage.css` returned `304`, so the browser reused its cached copy after revalidation.
- This does not prove stale production JS/CSS caused the reported issue, but it remains plausible unless production is tested with cache disabled or cache-busted asset URLs.

## Root Cause

Most likely root cause class: backend selector drift plus stale UI action state, with historical bad current rows as a secondary data-pollution vector.

Specific findings:

1. Deployed-current status is unconfirmed. The deployed endpoint exists, but useful mode calls are auth-gated and management listing is unavailable without a Supabase access token.
2. Browser cache is plausible. Static assets are not content-versioned, and local verification saw cached CSS revalidation.
3. Backend can still return a current draft that is not compatible with the selected UI classification because `admin_draft_view` is message-canonical while regenerate/review are draft/classification-canonical.
4. Old invalid/error rows from before Step 4D.7A can still pollute reads if they remain `is_current = true`.
5. `operator_match_context` and `admin_draft_view` can agree on message-current state but disagree with the selected classification context.
6. `response_draft_classification_mismatch` is still explainable by selector drift: UI sends selected classification ID plus current draft ID, while current draft may belong to another classification.
7. `Refresh Drafts` clears `draftActionErrorsByMessageId[messageId]` only after a successful `admin_draft_view` response. If refresh fails, stale action banners can remain.
8. `Regenerate Draft` reloads draft and match context only on success. If regenerate fails, it leaves the previous draft payload visible and sets a message-scoped action error banner.

## Minimal Repair Plan

Recommended, after one authenticated live pass confirms current production rows:

1. Add explicit mismatch metadata to `admin_draft_view` when both `messageId` and `classificationId` are supplied and returned drafts include a different `classification_id`.
2. Make the UI choose a draft using a canonical selector:
   - prefer current valid draft for selected classification
   - otherwise show message-current draft as cross-classification with a non-actionable warning
   - do not send selected classification ID with an incompatible draft ID
3. Clear stale `draftActionErrorsByMessageId[messageId]` when the selected classification changes and when Refresh Drafts starts, not only after a successful response.
4. After `regenerate_response`, inspect the response fields:
   - if `draft_became_current === false`, keep the previous current draft selected and show the failed attempt as history/non-current
   - if `draft_became_current === true`, force reload and select the new current draft
5. Add a small one-time read-only admin diagnostic query or UI banner for historical `is_current=true AND validation_status IN ('invalid', 'error')` rows, so operators can see data pollution without mutating rows.
6. Add cache-busting for local/static deploys, either by content-hashed filenames or query versions on `email-triage.js` and `email-triage.css`.

## Files Likely Needing Changes

- `supabase/functions/microsoft-email-classify/index.ts`
  - `adminDraftView`
  - `latestValidationForMessage`
  - response draft selector metadata
- `email-triage.js`
  - `currentDraftFromPayload`
  - `loadDraftView`
  - `runDraftAction`
  - `draftActionErrorsByMessageId`
  - selected classification/draft compatibility handling
- `email-triage.html`
  - optional cache-busted asset references

## Implementation Recommendation

Implementation is recommended, but not before one authenticated live verification pass.

The local code strongly suggests the previous "failed draft becomes current" backend bug was repaired for new writes. The still-open problem is that the UI/backend selector contract remains ambiguous and can still surface old rows or incompatible draft/classification pairs.

Before implementing, use an authenticated admin session to capture:

- `admin_draft_view` output for `4effe1f7-2f82-4a86-b8c4-94e986267986`
- `operator_match_context` output for that same message
- one `regenerate_response` output and the follow-up `admin_draft_view`
- whether any returned current draft has `validation_status` of `invalid` or `error`
- whether current draft `classification_id` equals the selected UI classification ID

No schema changes, deploys, eBay/order/return/inventory mutations, Outlook mutations, auto-approval, auto-confirmation, or validation weakening were performed.
