# Step 5F.6A.1 Recovery Decision Audit

Audit date: 2026-06-03

Scope: recovery decision audit only. No production code changes, migrations, deployments, database changes, or frontend restores were performed as part of this audit.

## Executive Recommendation

Recommended path: **Option A - revert the current uncommitted frontend changes, keep the already-applied migration temporarily, then repair or replace the RPC in a dedicated validated step.**

The failed mailbox state is caused by the frontend now depending on `public.get_ebay_canonical_mailbox(...)`. The applied migration appears additive and read-only from the old application's perspective, so the previous frontend can safely ignore it. The safest immediate recovery is to restore the five frontend files to the last working committed state and redeploy the frontend only.

No immediate database rollback is recommended.

## Current Git State

Latest stable commits visible:

```text
aa4bcc0 Email: Step 5F.6A Canonical Sync Architecture Audit ( purpose: fix syncing glitches and inconsistency)
0cf8c92 Email: Step 5F.6O.3 Sync Semantics Reconciliation + Archive Scope Clarification
0ad1cfb Email:  Step 5F.6O.2 Backfill Timeout Recovery + Chunked Historical Import
d6bbcbb Email - Step 5F.6O.1 Sync Aggregation + Backfill Failure Audit
52aa3fd Email: Step 5F.6O Historical Backfill + Incremental Sync
```

Uncommitted frontend changes:

```text
M email-triage.api.js
M email-triage.css
M email-triage.html
M email-triage.js
M email-triage.state.js
```

Untracked migration introduced by the failed attempt:

```text
?? supabase/migrations/20260603170000_ebay_canonical_mailbox_read_model.sql
```

Other untracked paths were also present and are outside this recovery decision:

```text
?? Iphone_app/
?? node_modules/supabase/bin/supabase
```

Frontend diff size:

```text
email-triage.api.js   | 152 +++++++++++++++++++++++---
email-triage.css      |  44 ++++++++
email-triage.html     |   9 +-
email-triage.js       | 294 ++++++++++++++++++++++++++++++++++++++------------
email-triage.state.js |  10 ++
5 files changed, 424 insertions(+), 85 deletions(-)
```

## What The Failed Attempt Changed

The frontend mailbox load path was changed from the previous direct Supabase table query against `public.ebay_conversations` to an RPC-backed read model:

```text
supabase.rpc("get_ebay_canonical_mailbox", ...)
```

The UI/state was also changed to expect:

```text
canonical_total
matching_total
loaded_count
page_size
next_offset
has_more
conversations[]
smart_folder_counts
```

This means the new frontend has no reliable fallback when the RPC fails. A broken RPC causes the mailbox to render as empty even though the canonical tables still contain rows.

## Migration/RPC Safety

Inspected migration:

```text
supabase/migrations/20260603170000_ebay_canonical_mailbox_read_model.sql
```

The migration appears to:

- `create or replace function public.get_ebay_canonical_mailbox(...)`
- `revoke all on function ... from public`
- `revoke all on function ... from anon`
- `grant execute on function ... to authenticated`

It does **not** appear to change:

- Tables
- Columns
- Constraints
- Indexes
- Existing RLS policies
- Existing triggers
- Existing RPCs
- Edge Functions

Therefore the old frontend should safely ignore the new RPC. The applied migration is not expected to break the previously working mailbox, backfill, Sync Latest, dashboard events, or classification flows as long as the old frontend path is restored.

## Why The RPC Failed

### SQL Editor Failure

The SQL editor test returned:

```text
ERROR: P0001: not_authorized
CONTEXT: PL/pgSQL function get_ebay_canonical_mailbox(integer,integer,text,text[],jsonb,jsonb) line 17 at RAISE
```

This is explained by the RPC's explicit authorization guard:

```sql
if not public.can_manage_inventory() then
  raise exception 'not_authorized';
end if;
```

The SQL editor invocation did not provide the same authenticated browser/app context used by the frontend. The function fails before exercising the mailbox query body. That SQL editor test therefore does not prove the query logic works.

### Browser Failure

The browser showed:

```text
eBay conversation list failed: Error: 42703
```

Postgres error `42703` means `undefined_column`. Because the browser/app request likely passed the authorization guard, the function reached the SQL body and then failed on a bad SQL reference.

The strongest confirmed issue in the RPC definition is the `option_counts` CTE. It references `derived_source` inside aggregate filters without selecting from the CTE that defines `derived_source`.

The buggy pattern is:

```sql
option_counts as (
  select jsonb_build_object(
    'sourceTypes', jsonb_build_object(
      'member_message', count(*) filter (where derived_source = 'member_message'),
      'platform_notification', count(*) filter (where derived_source = 'platform_notification')
    )
  ) as counts
)
```

There is no outer `from base` in that CTE, so `derived_source` is out of scope. This is a SQL scope/schema validation failure inside the RPC, not merely a frontend rendering bug.

The RPC correctly avoided the nonexistent `ebay_conversations.conversation_source` column and derived source from:

```text
ebay_conversations.conversation_type
```

However, the derived alias was then referenced from the wrong SQL scope.

## Should We Reject The Current Frontend Changes?

Yes.

The current frontend changes should be rejected/restored immediately because:

- They route the mailbox through a broken RPC.
- There is no feature flag or fallback to the old working query path.
- The UI now reports `0 canonical`, `0 matching`, and empty smart folder counts even though the database still has 300 conversations and 888 messages.
- Patching forward requires RPC repair plus app-auth validation, which should not happen while the operator-facing mailbox is broken.

Recommended restore target:

```bash
git restore email-triage.api.js email-triage.js email-triage.state.js email-triage.html email-triage.css
```

## Is A Rollback Migration Needed?

No immediate rollback migration is recommended.

The migration has already been pushed to Supabase, but it appears additive and isolated to one new RPC plus function grants. Since the previously working frontend does not call `public.get_ebay_canonical_mailbox(...)`, restoring the frontend should recover the app without touching the database.

A rollback or repair migration becomes necessary only when choosing the next durable database state. That next migration should either:

- replace `public.get_ebay_canonical_mailbox(...)` with a validated implementation, or
- introduce a versioned replacement RPC and leave the broken function unused until it can be dropped safely.

Do not create a database rollback during the emergency UI recovery unless additional evidence shows the new function or grants are interfering with existing app behavior.

## What The Failed 5F.6A.1 Attempt Missed

The failed attempt should not have been declared ready without these gates:

- RPC smoke test under the same authenticated app context used by the browser.
- SQL validation of every referenced column and alias against the actual schema.
- Proof that `conversation_type`, not nonexistent `conversation_source`, powers Members/eBay Notifications.
- Browser validation that the first page loads and renders nonzero data.
- Verification that `smart_folder_counts.all` returns 300 when `public.ebay_conversations` has 300 rows.
- Fallback to the old mailbox query path if the RPC fails.
- Feature flag or runtime switch allowing fast rollback without editing multiple frontend files.
- Explicit frontend rollback plan before deployment.
- Regression checks for Sync Latest, backfill chunks, dashboard events, classifications, manual sends, AI drafts, and unread state.

## Safest Next Implementation Strategy

Recommended strategy: **Option A now, followed by a narrow RPC repair/read-model step.**

Immediate recovery:

1. Restore the five frontend files to the last committed working state.
2. Redeploy the frontend using the existing production frontend deploy flow.
3. Leave the applied migration in place temporarily because the restored frontend ignores it.
4. Confirm mailbox returns to the known working behavior: 100 loaded conversations, backfill works in chunks, Sync Latest works, dashboard events remain durable.

Next implementation step:

1. Repair or replace the RPC in a new migration.
2. Add a frontend feature flag/fallback before routing production mailbox reads through the RPC.
3. Validate the RPC through the browser's actual auth/session path before deployment.
4. Deploy the frontend only after the app-auth validation passes.

Do not patch the current frontend forward while the mailbox is broken. The blast radius is too broad for a live operator surface.

## Validation Gate For The Next Coding Step

The next implementation step must prove all of the following before it is considered deployable:

- The app can load mailbox data through the new read model under the same auth context used by the browser.
- The RPC returns nonzero data when the database has rows.
- `canonical_total` equals the database conversation count, currently expected to be 300.
- `smart_folder_counts.all` equals the canonical database count.
- Members and eBay Notifications counts are derived from `ebay_conversations.conversation_type`.
- Search runs against the full archive, not only the loaded page.
- Pagination or Load More returns additional rows without duplicates.
- The mailbox has a fallback path to the old direct query or a feature flag that can disable the RPC path quickly.
- Sync Latest still works and does not alter the archive checkpoint.
- Backfill plus classify-new still works in chunks.
- Dashboard status still reflects durable events after transient browser fetch failures.
- Console/network logs show no mailbox load errors.

## Exact Operator Commands For Immediate Recovery

Restore the frontend files:

```bash
git restore email-triage.api.js email-triage.js email-triage.state.js email-triage.html email-triage.css
```

Confirm only the intended untracked migration and unrelated paths remain:

```bash
git status --short
```

No immediate database command is recommended:

```bash
# Do not run supabase db push for this recovery.
# Do not create or apply a rollback migration for this recovery.
# Do not deploy any Supabase Edge Function for this recovery.
```

Redeploy the frontend using the existing frontend deploy procedure for this project. No Edge Function deployment is needed for this recovery path.

## Final Recovery Decision

Use **Option A**:

```text
Revert frontend now.
Keep the applied migration temporarily.
Do not perform immediate DB rollback.
Repair or replace the RPC in a later validated step.
```

This restores the last known working mailbox behavior with the smallest blast radius while preserving a clear path to implement the canonical read model correctly.
