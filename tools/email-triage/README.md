# Email Triage Draft Regression Checks

## Purpose

`run-draft-regression-checks.js` is a small runtime harness for the Email Triage draft system. It verifies the Step 4D.7 invariants that protect current draft state, fallback behavior, selector alignment, and diagnostic health.

Default mode is read-only. It only calls diagnostic and draft-view Edge Function modes.

## Required Environment Variables

- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_ANON_KEY`: Public anon key used as the Edge Function `apikey` header.
- `EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN`: Authenticated admin user access token used as the Bearer token.

Do not hardcode tokens. The script never prints the token and does not save it.

## Optional Environment Variables

- `EMAIL_TRIAGE_FUNCTION_NAME`: Edge Function name. Defaults to `microsoft-email-classify`.
- `EMAIL_TRIAGE_REQUEST_TIMEOUT_MS`: Request timeout. Defaults to `30000`.
- `EMAIL_TRIAGE_RUN_MUTATING_CHECKS=true`: Enables optional mutating checks, equivalent to `--generate`.

## Run Read-Only Checks

```bash
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_ANON_KEY="..." \
EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN="..." \
node tools/email-triage/run-draft-regression-checks.js
```

Read-only mode calls:

- `diagnose_all_bad_current_drafts`
- `diagnose_message_draft_state`
- `diagnose_selector_contract`
- `admin_draft_view` with `includeDraftBody: true`

It exits `0` when all checks pass or warnings only exist. It exits `1` when any failure exists.

## Run Optional Mutating Checks

Mutating checks are disabled by default. Enable them only when you intentionally want to create draft rows through `regenerate_response`.

```bash
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_ANON_KEY="..." \
EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN="..." \
node tools/email-triage/run-draft-regression-checks.js --generate
```

or:

```bash
EMAIL_TRIAGE_RUN_MUTATING_CHECKS=true node tools/email-triage/run-draft-regression-checks.js
```

Mutating mode verifies that a newly current draft is valid and has body text, or that a failed/invalid generation preserves the previous current draft and creates no polluted current draft.

## Checks

`no polluted current drafts`

Calls `diagnose_all_bad_current_drafts` with `limit: 100`. Fails if `affected_messages` is nonzero or if any polluted current draft is returned.

`weak cancellation`

Checks message `4effe1f7-2f82-4a86-b8c4-94e986267986`. The current draft must be valid, pollution must be false, invalid/bodyless current draft diagnostics must be false, selector current draft must be usable, and `admin_draft_view` must return the draft body.

`return request`

Checks message `514a6c14-2cf6-4233-8fef-95798437ff62`. This was the historical polluted message. The current draft must be valid, pollution must be false, best usable draft must exist, invalid/bodyless current draft diagnostics must be false, and `admin_draft_view` must return the draft body.

Duplicate classifications for this message are a warning, not a failure.

`selector contract`

Calls `diagnose_selector_contract` for known messages. A valid current draft is required. Explicit selector mismatch risk is reported as a warning so UI/backend contract drift remains visible without failing known duplicate-classification cases.

## What To Do On Failure

For polluted current drafts:

```text
suggested action: run repair_bad_current_drafts dryRun=true
```

Review the failed `message_id`, `draft_id`, `validation_status`, and `validation_errors` printed by the script. Do not run repair in live mode until the dry-run output has been reviewed.

For missing draft body:

Check whether the current draft is invalid/error, bodyless, or considered unsafe for content return. `admin_draft_view` reports `draft_content_omitted_reason` when content is not returned.

For selector warnings:

Inspect duplicate classifications or mismatched current classification/current draft ownership. Warnings are intentional when the current draft remains valid and usable.

## Safety Notes

- Default mode is read-only.
- The script does not send email.
- The script does not mutate Outlook.
- The script does not approve or reject drafts.
- The script does not confirm matches.
- The script does not modify eBay, order, return, or inventory data.
- Optional `--generate` mode is the only path that calls `regenerate_response`.
