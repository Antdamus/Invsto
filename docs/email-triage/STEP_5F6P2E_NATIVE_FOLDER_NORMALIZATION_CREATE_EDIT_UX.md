# Step 5F.6P.2E - Native Folder Normalization + Create/Edit UX

## What Was Wrong

Native smart folders were not fully using the same visible-label model as custom folders.

| Folder | Before saved-view payload | Before runtime behavior |
|---|---|---|
| VIP buyers | `version:1`, `system_filter:"vip_buyers"`, empty `classification_filters`, no `label_rules` in the original seed | Count matched `vip_buyer`, but `VIP Buyer` did not light up because the filter panel only read `classification_filters`. |
| High value | `version:1`, `system_filter:"high_value_buyers"`, empty `classification_filters`, no `label_rules` in the original seed | RPC logic included `high_value_buyer OR high_retained_value_buyer`; `High Value Buyer` did not light up. |
| Refund risk | `version:1`, `system_filter:"refund_risk"`, empty `classification_filters`, no `label_rules` in the original seed | RPC logic included `refund_risk OR chargeback_risk OR unsupported_claim_risk`; `Refund Risk` did not light up and counts were broader than the visible tag. |

A later migration had started adding `label_rules`, but the frontend still treated those rules mostly as display metadata. Selecting a native folder did not translate `label_rules.required_labels` back into active Classification Filters.

## What Changed

- `label_rules.required_labels` are now reversible: saved-view label rules are translated into active system/state/source/AI filter controls.
- Native AI folders now light up the exact AI labels:
  - `VIP buyers` -> `ai:vip_buyer`
  - `High value` -> `ai:high_value_buyer`
  - `Refund risk` -> `ai:refund_risk`
- Legacy fallback counts and conversation label summaries now use exact folder labels for High Value Buyer and Refund Risk.
- Native folder rail counts use exact label option counts in the frontend, so the visible count matches the visible chip even before the RPC migration is deployed.
- Added migration `20260609133000_email_triage_native_folder_exact_label_counts.sql` to harden the database RPC branches and native saved-view rows.

## Native Definitions After

| Folder | Saved-view payload after | RPC after migration |
|---|---|---|
| VIP buyers | `system_filter:"vip_buyers"`, `label_rules.operator:"AND"`, `required_labels:["ai:vip_buyer"]` | `buyer_flags @> array['vip_buyer']` |
| High value | `system_filter:"high_value_buyers"`, `label_rules.operator:"AND"`, `required_labels:["ai:high_value_buyer"]` | `buyer_flags @> array['high_value_buyer']` |
| Refund risk | `system_filter:"refund_risk"`, `label_rules.operator:"AND"`, `required_labels:["ai:refund_risk"]` | `risk_flags @> array['refund_risk']` |

`high_retained_value_buyer`, `chargeback_risk`, and `unsupported_claim_risk` are no longer silently included in these native folder definitions. They still appear as their own labels where present.

## Create/Edit UX

- The top action now says `Create folder`.
- Clicking it enters a visible `CREATE SMART FOLDER` mode inside Classification Filters.
- Create mode includes name entry, selected label chips, `Save folder`, and `Cancel`.
- Folder creation is deferred until `Save folder`.
- Edit draft mode now appears in Classification Filters with:
  - `SMART FOLDER EDIT MODE`
  - `Editing: <folder name>`
  - selected label chips
  - `Reset to saved`
  - `Save`
  - `Cancel`
- Draft filter changes are isolated until save; cancel restores the prior saved state.

## Playwright Evidence

Successful report:

`tests/email-triage/reports/email-triage-regression-2026-06-09T04-21-30-670Z.md`

Key evidence:

| Check | Result |
|---|---|
| Native `VIP buyers` | `VIP Buyer`, expected count `52`, RPC matching total `52` |
| Native `High value` | `High Value Buyer`, expected count `59`, RPC matching total `59` |
| Native `Refund risk` | `Refund Risk`, expected count `179`, RPC matching total `179` |
| Create folder from AI label | Passed, reload persistence confirmed |
| Create folder from system label | Passed, reload persistence confirmed |
| Create folder from AI + system label | Passed, reload persistence confirmed |
| Edit folder remove/reset/save | Passed, reload persistence confirmed |
| Blocked send attempts | `0` |

Regression commands:

- `node --check email-triage.js` - passed
- `node --check email-triage.api.js` - passed
- `node --check tests/email-triage/email-triage-regression.spec.mjs` - passed
- `git diff --check` - passed
- `npm run test:ebay-notification` - passed, 8 tests
- `npm run test:email-triage` - passed, 2 tests

`node_modules/supabase/bin/supabase db lint` could not run because local Supabase Postgres was not running at `127.0.0.1:54322`.

## Deployment Requirements

Frontend deploy required:

- `email-triage.html`
- `email-triage.js`
- `email-triage.css`
- `email-triage.state.js`
- `email-triage.api.js`

Database migration required:

- `supabase/migrations/20260609133000_email_triage_native_folder_exact_label_counts.sql`

The frontend change makes the UI behave correctly immediately by applying label-derived filters when a native folder is selected. The migration is still required so direct RPC calls using only `_system_filter = high_value_buyers` or `_system_filter = refund_risk`, plus canonical smart-folder counts, are exact-label on the server as well.

## eBay Safety

This step only changes UI state, saved folder records, and read-only mailbox RPC definitions. The successful Playwright report recorded `Blocked send attempts: 0`; provider read-state and live sync mutation checks were skipped unless explicitly enabled by env flags.
