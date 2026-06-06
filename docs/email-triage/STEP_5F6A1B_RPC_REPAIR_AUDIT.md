# Step 5F.6A.1B RPC Repair Audit + Validation Gate

Audit date: 2026-06-06

Scope: audit only. No production code, frontend code, SQL behavior, Edge Functions, migrations, database objects, deployments, eBay state, Outlook state, secrets, or tokens were changed.

Source-of-truth documents read:

- `docs/email-triage/STEP_5F6A_CANONICAL_SYNC_ARCHITECTURE_AUDIT.md`
- `docs/email-triage/STEP_5F6A1_RECOVERY_DECISION_AUDIT.md`

Primary failed artifact inspected:

- `supabase/migrations/20260603170000_ebay_canonical_mailbox_read_model.sql`

## Executive Summary

The canonical mailbox RPC architecture is directionally correct: the mailbox needs a server-side read model that returns archive-wide rows, exact totals, exact saved-view counts, search results, and pagination metadata. The original problem remains real:

```text
Database conversations = 300
Mailbox loaded = 100
```

The failed implementation broke because the frontend was switched to depend on an unvalidated RPC. The RPC itself contains a deterministic SQL scope bug:

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

`derived_source` is defined only inside the `base` CTE. The `option_counts` CTE has no `from base`, so `derived_source` is out of scope. PostgreSQL reports this as:

```text
42703 undefined_column
```

That is the exact root cause of the browser-side RPC failure in the inspected failed RPC.

The SQL editor failure is different. The function begins with:

```sql
if not public.can_manage_inventory() then
  raise exception 'not_authorized';
end if;
```

A plain SQL editor invocation does not provide the same authenticated browser JWT context used by the app, so `auth.uid()` is null or not the app user's id, `public.can_manage_inventory()` returns false, and the function raises:

```text
P0001 not_authorized
```

That SQL editor result was expected under the current auth model. It did not exercise the mailbox query body.

Recommendation: **Option B - replace the current RPC implementation with a new validated version, while preserving the RPC/read-model architecture.**

Do not abandon the RPC design. Also do not do a one-line patch and immediately reconnect the frontend. The next implementation should replace the current body in a new migration, validate it under app auth against production mailbox data while the frontend still uses the restored direct-query path, and only then allow frontend use behind a fallback/feature flag.

## Current Working State

The restored frontend is the correct current production posture:

```text
Mailbox loads.
Dashboard loads.
Backfill works.
Sync Latest works.
Classification works.
Unread works locally.
```

Known limitation:

```text
Database contains more conversations than the mailbox displays.
```

This is explained by the current direct table loader:

```text
fetchEbayConversations default limit = 100
loadEbayConversationList fetches one limited page
state.ebayConversations is replaced with that page
smart folder counts are computed from loaded rows
```

The failed RPC migration is additive from the old frontend's perspective. The restored frontend does not call it, so leaving it present temporarily is not expected to break the current working app.

## RPC Audit

### Inputs

`public.get_ebay_canonical_mailbox(...)` accepts:

| Input | Type | Default | Handling |
| --- | --- | --- | --- |
| `_page_size` | `integer` | `100` | Clamped to `1..100`. |
| `_offset` | `integer` | `0` | Clamped to `>= 0`. |
| `_system_filter` | `text` | `all` | Trimmed, lowercased, empty becomes `all`. |
| `_search_terms` | `text[]` | `{}` | Trimmed, lowercased, distinct, empty terms removed. |
| `_structured_filters` | `jsonb` | `{}` | Reads `sourceTypes`, `topics`, `buyerFlags`, `riskFlags`, `priorities`, `responseNeeds`, and `tags`. |
| `_classification_filters` | `jsonb` | `{}` | Reads `sourceTypes`, `topics`, `buyerFlags`, `riskFlags`, `priorities`, and `responseNeeds`. |

Structured and classification filter arrays are merged for most filter groups.

Important input limitation:

```text
sourceTypes filtering only supports zero filters or exactly one source filter.
```

This clause ignores multi-source filter arrays:

```sql
cardinality(v_filter_sources) = 0
or (cardinality(v_filter_sources) = 1 and b.derived_source = v_filter_sources[1])
```

### Outputs

The function returns one `jsonb` object:

```text
ok
canonical_total
matching_total
loaded_count
page_size
offset
next_offset
has_more
system_filter
search_terms
structured_filters
classification_filters
smart_folder_counts
filter_option_counts
conversations
loaded_at
```

The `conversations` array includes only page-row conversation columns:

```text
id
seller_account_id
ebay_conversation_id
conversation_type
conversation_status
conversation_title
other_party_username
reference_id
reference_type
unread_count
latest_message_id
latest_message_created_at
latest_message_preview
first_message_created_at
last_message_created_at
message_count
last_synced_at
last_detail_synced_at
updated_at
created_at
```

It does not return the same normalized row shape as the current frontend loader. In particular, the page rows omit per-row classification, seller username, link summary, message summary, `has_order`, `has_return`, `has_media`, `needs_context_review`, and effective source fields. The RPC uses those fields internally for search/counts, but does not expose them in `conversations`.

That output mismatch is not the 42703 cause, but it is a frontend integration risk.

### Authorization Model

The RPC is:

```text
language plpgsql
stable
security invoker by default
set search_path = public
```

It explicitly checks:

```sql
if not public.can_manage_inventory() then
  raise exception 'not_authorized';
end if;
```

The current `public.can_manage_inventory()` definition is a security-definer SQL function that returns true when `auth.uid()` maps to an active employee with role:

```text
admin
manager
employee
seller
```

The migration also does:

```sql
revoke all on function public.get_ebay_canonical_mailbox(...) from public, anon;
grant execute on function public.get_ebay_canonical_mailbox(...) to authenticated;
```

Expected behavior:

- Anonymous callers cannot execute the function.
- Authenticated non-staff callers fail `not_authorized`.
- Authenticated inventory/seller staff can pass the guard.
- Plain SQL editor calls without app JWT context can fail `not_authorized`.
- Browser calls can succeed where SQL editor calls fail, if the browser session belongs to an authorized staff user.

Because the function is security invoker, table RLS still applies to the caller. The underlying eBay messaging tables already use `public.can_manage_inventory()` select policies, so the RPC's guard and the table policies are aligned for staff browser sessions.

### Count Model

The RPC builds a materialized `base` CTE over all visible `ebay_conversations`, joined to:

- `ebay_seller_accounts`
- current `ebay_conversation_classifications`
- lateral link statistics from `ebay_conversation_links`, `ebay_orders`, `ebay_order_lines`, `ebay_return_cases`
- lateral message statistics from `ebay_conversation_messages`

Then it builds:

```text
filtered = base after system/search/structured/classification filters
page_rows = filtered after order/offset/limit
```

Returned totals:

| Output | Source |
| --- | --- |
| `canonical_total` | `count(*) from base` |
| `matching_total` | `count(*) from filtered` |
| `loaded_count` | `count(*) from page_rows` |

With no filters and authorized access, the intended result for the current production observation is:

```text
canonical_total = 300
matching_total = 300
loaded_count = 100
has_more = true
next_offset = 100
```

The SQL editor test never reached this count model because it failed authorization first.

### Folder Count Model

`smart_counts` is computed from `base`, not `filtered`.

That means folder badges are intended to be global canonical counts across all visible conversations, independent of the active filter/search.

Folder predicates:

| Folder key | Predicate |
| --- | --- |
| `all` | every row in `base` |
| `members` | `conversation_type = 'FROM_MEMBERS'` |
| `ebay_notifications` | `conversation_type = 'FROM_EBAY'` |
| `unread` | `unread_count > 0` |
| `returns` | `has_return_link` or topic tag contains `return` |
| `shipping_issues` | topic tag overlaps `shipping_issue`, `missing_item`, `order_status`, `delivery_timing` |
| `needs_reply_today` | `response_need = 'reply_today'` |
| `vip_buyers` | buyer flag contains `vip_buyer` |
| `high_value_buyers` | buyer flag contains `high_value_buyer` or `high_retained_value_buyer` |
| `refund_risk` | risk flag contains `refund_risk`, `chargeback_risk`, or `unsupported_claim_risk` |
| `review_queue` | missing/stale classification, missing/suggested links, stale latest-message classification, or review risk flags |
| `has_order` | has confirmed/suggested order/order-line link |
| `has_return` | has confirmed/suggested return-case link |
| `has_media` | has at least one message with media |
| `needs_context_review` | no links or suggested links exist |

This count model addresses the original loaded-row-count bug in concept. It is not currently usable because the function fails later in `option_counts`.

### Filter Option Count Model

`option_counts` is intended to return available filter counts:

```text
sourceTypes
topics
buyerFlags
riskFlags
priorities
responseNeeds
```

Most option groups use subqueries from `base`.

The source-type option counts are broken because they reference `derived_source` without `from base`.

Correct conceptual dependency:

```text
derived_source = case conversation_type
  FROM_EBAY -> platform_notification
  otherwise -> member_message
```

Actual broken scope:

```text
option_counts has no range table exposing derived_source
```

### Search Model

The RPC builds a lowercased `search_text` string in `base` from:

- conversation identity/status/title/party/reference fields
- derived source
- seller username
- classification priority, response need, tags, summary, reasoning, recommended action
- linked order/order-line/return metadata
- message ids, participants, directions, subjects, previews, and bodies

Search terms are ANDed:

```sql
not exists (
  select 1
  from unnest(v_search_terms) as term(value)
  where b.search_text not like '%' || term.value || '%'
)
```

Intended behavior:

```text
Every provided term must match the archive-wide search text.
```

Risks:

- It uses `like` against a generated text blob, not full-text search.
- `%` and `_` in user input are not escaped, so they behave as SQL wildcards.
- The lateral message and link aggregations happen before pagination, so the query may become expensive as the archive grows.

### Pagination Model

Pagination is offset-based:

```sql
order by latest_message_created_at desc nulls last, updated_at desc nulls last, id desc
offset v_offset
limit v_page_size
```

Metadata:

```text
next_offset = offset + loaded_count when more rows exist
has_more = offset + loaded_count < matching_total
```

This is acceptable for a small archive smoke test. It is less stable than keyset pagination if sync updates timestamps while an operator pages through the mailbox.

## Browser Failure Root Cause

Observed browser failure:

```text
42703
Mailbox showed 0 canonical / 0 matching / 0 loaded
```

Root cause:

```text
The authorized browser call reached the SQL body of public.get_ebay_canonical_mailbox(...).
The final SELECT includes option_counts.
option_counts references derived_source without selecting from base.
PostgreSQL raises 42703 undefined_column.
The frontend had no fallback to the old direct table query.
The mailbox therefore rendered the failure as an empty canonical result.
```

This is not caused by `ebay_conversations.conversation_source`. The RPC does not reference that nonexistent column. It correctly derives source from `ebay_conversations.conversation_type`, but then references the derived alias from the wrong SQL scope.

The failure is also not explained by an empty database. The supplied counts prove canonical data existed:

```text
public.ebay_conversations = 300
public.ebay_conversation_messages = 888
```

## SQL Editor Failure Root Cause

Observed SQL editor failure:

```sql
select public.get_ebay_canonical_mailbox(
  100,
  0,
  'all',
  array[]::text[],
  '{}'::jsonb,
  '{}'::jsonb
);
```

Returned:

```text
ERROR: P0001 not_authorized
```

Root cause:

```text
The function intentionally calls public.can_manage_inventory().
public.can_manage_inventory() depends on auth.uid().
The plain SQL editor invocation did not carry the app user's authenticated JWT context.
auth.uid() therefore did not map to an active staff employee.
The function raised not_authorized before executing the mailbox query CTEs.
```

Was this expected?

```text
Yes, for a plain SQL editor invocation without app auth context.
```

Was this a bug?

```text
No, not as an authorization behavior. It is a validation-process gap because the attempted SQL editor test was not equivalent to browser auth.
```

Was the function intentionally blocking SQL editor?

```text
It was intentionally blocking callers without an authorized staff auth context. The SQL editor happened to be such a caller for this test.
```

Would browser auth succeed where SQL editor fails?

```text
Yes, for an authenticated browser session whose auth.uid() maps to an active employee role accepted by public.can_manage_inventory().
```

The browser's different error code supports this sequence: the browser did not receive `P0001`; it received `42703`, which means it passed the authorization guard and failed inside the SQL query body.

## Recovery Audit Validation

The recovery audit correctly identified `derived_source` as the likely failure. This audit upgrades that finding from likely to confirmed for the inspected RPC body.

Confirmed facts:

- `derived_source` is defined in `base`.
- `filtered` references `b.derived_source` correctly because it selects from `base b`.
- `option_counts` references `derived_source` without a `from base`.
- The final result selects from `option_counts`, so every successful authorized call must evaluate the broken CTE.
- PostgreSQL error `42703` is the exact class of error produced by an out-of-scope or nonexistent column reference.

The nonexistent `conversation_source` column on `public.ebay_conversations` remains an important schema fact, but it is not the direct RPC browser failure. Source must continue to be derived from `conversation_type` or read from `ebay_conversation_classifications.conversation_source`, not assumed on `ebay_conversations`.

## Salvageability Assessment

Chosen option:

```text
Option B - Replace current RPC with a new version.
```

Reasoning:

The RPC architecture is correct, but the current implementation should not be treated as production-ready after a one-line fix.

What is salvageable:

- Server-side canonical mailbox read model.
- Archive-wide totals.
- Archive-wide search/filter semantics.
- Smart folder counts derived from real database predicates.
- Source derivation from `conversation_type`.
- Offset pagination as an initial small-archive implementation.

What is not acceptable as-is:

- Runtime SQL scope bug in `option_counts`.
- No validation gate before frontend dependency.
- No browser-auth smoke test before cutover.
- No fallback/feature flag in the frontend.
- Output shape does not match the current normalized frontend row shape.
- Monolithic `base` CTE aggregates links and all messages before pagination, which may become slow.
- Search uses unescaped `like` wildcard behavior.
- `sourceTypes` filter only supports exactly one selected source.

Why not Option A?

```text
Repairing the current function with only from base in option_counts would probably clear the observed 42703, but it would not prove the output contract, browser auth behavior, count correctness, or frontend integration safety.
```

Why not Option C?

```text
The original problem is a read-model problem. Abandoning the RPC/server-side read model would leave counts, search, and pagination split across loaded frontend rows again.
```

Recommended replacement style:

```text
Replace the RPC body in a new migration, or introduce a versioned replacement RPC and leave the broken function unused until it can be safely dropped.
```

The current restored frontend should remain on the old direct query until the replacement RPC passes the validation gate.

## Previous Attempt Review

### Step 5F.6A.1

What went wrong:

- The frontend mailbox load path was switched to `supabase.rpc("get_ebay_canonical_mailbox", ...)`.
- The RPC had not passed an authenticated browser-context smoke test.
- The SQL editor test failed at authorization and therefore did not validate the query body.
- The frontend had no fallback to the old direct `ebay_conversations` query.
- The mailbox rendered an RPC failure as zero canonical rows.

Incorrect assumptions:

- A SQL editor invocation was treated as enough validation for an app-auth RPC.
- The RPC body was assumed to be valid despite not being exercised past the auth guard.
- A new read model could be made mandatory in the operator UI before proving nonzero production results.

Missing safeguards:

- SQL/body validation under an authorized context.
- Browser-session RPC validation.
- Exact count comparison against independent SQL.
- Frontend feature flag or fallback.
- Rollback plan before deployment.
- Proof that smart folder counts stayed nonzero against production data.

### Step 5F.6O.4 And Step 5F.6O.4A

Repository evidence boundary:

```text
No committed docs, commit subjects, or visible reflog entries named Step 5F.6O.4 or Step 5F.6O.4A were found in the current repository history available to this audit.
```

Therefore, this audit cannot line-review those discarded attempts as source artifacts.

The available audits and prompt history do show the failure pattern those attempts must not repeat:

- Backfill/sync improvements were treated as adjacent to mailbox completeness, but they do not make the frontend load more than its first limited page.
- Dashboard canonical totals were available, but mailbox smart folder counts still came from loaded frontend rows.
- The existence of 300 database conversations was not translated into a validated mailbox read contract.
- The absence of `ebay_conversations.conversation_source` was known, but source-related implementation still needed strict schema validation.
- UI changes were allowed to depend on unproven backend behavior.

Incorrect assumptions to avoid:

- Backfill success means mailbox display completeness.
- Dashboard canonical count means mailbox row/count model is canonical.
- Frontend-loaded rows can safely represent archive-wide saved views.
- SQL editor testing without app auth validates browser behavior.
- A read-only migration is automatically safe to wire into the UI.

Missing safeguards:

- Independent DB count assertions before and after mailbox RPC calls.
- Authenticated browser-session RPC test.
- Production-data test with expected nonzero rows.
- Page 2 pagination test.
- Folder-count comparison against standalone SQL.
- Feature flag/fallback before frontend cutover.
- Explicit "do not deploy frontend until gate passes" rule.

## Validation Gate

The replacement RPC must pass this gate before any frontend path is allowed to use it.

### Gate 1: Schema And SQL Body Validation

Run a SQL validation pass that proves:

```text
The function compiles.
The authorized function call reaches the query body.
No 42703, 42P01, 42883, or P0001 occurs under the intended auth context.
All referenced columns exist in the real schema.
All derived aliases are referenced only in valid scopes.
```

The validation must specifically cover:

```text
conversation_type
latest_message_preview
message_body_preview
message_body
conversation_source on classifications only
no conversation_source reference on ebay_conversations
derived_source scope
```

### Gate 2: Independent Production Counts

Before calling the RPC, capture independent counts against production mailbox data:

```sql
select count(*) as conversations
from public.ebay_conversations;

select count(*) as messages
from public.ebay_conversation_messages;

select conversation_type, count(*)
from public.ebay_conversations
group by conversation_type;

select count(*)
from public.ebay_conversations
where unread_count > 0;
```

Current expected baseline from supplied facts:

```text
conversations = 300
messages = 888
```

### Gate 3: Authorized Browser-Context RPC Smoke Test

Call the RPC through the same Supabase browser client/session that the app uses, while the production UI still uses the restored direct-query path.

Minimum assertion:

```text
RPC returns ok = true.
RPC returns conversations.length > 0.
RPC canonical_total equals independent DB conversation count.
RPC matching_total equals canonical_total for all/no-search.
RPC loaded_count equals conversations.length.
RPC page_size equals requested/clamped page size.
RPC has_more is true when canonical_total > loaded_count.
RPC next_offset is non-null when has_more is true.
No browser console/network RPC errors occur.
```

For current data, the no-filter call should prove:

```text
canonical_total = 300
matching_total = 300
loaded_count = 100
conversations.length = 100
has_more = true
next_offset = 100
```

### Gate 4: Pagination Validation

Call:

```text
page 1: page_size 100, offset 0
page 2: page_size 100, offset 100
page 3: page_size 100, offset 200
```

Assertions:

```text
Each page returns rows while rows remain.
No duplicate conversation ids across pages.
Combined unique ids after three pages equals 300 for the current baseline.
The final page has has_more = false.
```

### Gate 5: Smart Folder Count Validation

Compare RPC `smart_folder_counts` against independent SQL for at least:

```text
all
members
ebay_notifications
unread
has_order
has_return
has_media
needs_context_review
```

Required assertions:

```text
smart_folder_counts.all = 300
members + ebay_notifications = 300
counts that are independently nonzero are nonzero in the RPC
no count silently collapses to zero because of an RPC error
```

For classification-derived folders, compare against standalone classification/link/message predicates. If a production folder is truly zero, record that as an expected zero with the independent SQL evidence.

### Gate 6: Search And Filter Validation

Use known production values from existing rows.

Assertions:

```text
Search for a known ebay_conversation_id returns that row.
Search for a known buyer username or reference id returns matching rows.
members filter returns only FROM_MEMBERS.
ebay_notifications filter returns only FROM_EBAY.
unread filter matches unread_count > 0.
sourceTypes filters match conversation_type-derived source.
No filter references ebay_conversations.conversation_source.
```

### Gate 7: Frontend Shadow Contract Validation

Before frontend cutover, prove the RPC output can support the current UI row needs.

Required decision:

```text
Either the RPC returns the normalized row fields the UI needs,
or the frontend keeps a separate page-detail enrichment fetch,
or the frontend uses the RPC only for counts/search/page ids and preserves existing row hydration.
```

This must be decided before deployment because the failed RPC currently returns less per-row data than `fetchEbayConversations`.

### Gate 8: Cutover Safety

Frontend use is blocked until:

```text
RPC validation has passed in production auth context.
Fallback to the old direct query exists.
Feature flag or runtime switch can disable the RPC path.
Console/network logs are clean.
Rollback steps are documented before deploy.
```

## Recommended Next Implementation Step

One recommended path:

```text
Create a replacement canonical mailbox RPC migration, validate it in production under app auth while the restored frontend remains on the old direct-query path, and do not connect the frontend until the full validation gate passes.
```

Risk level:

```text
Medium.
```

Reason:

```text
The migration is read-only and the current frontend ignores the RPC, but the query touches several tables and will become a central operator read path once connected.
```

Expected effort:

```text
0.5 to 1.5 engineering days for replacement SQL plus validation.
Additional frontend time only after the RPC gate passes.
```

Deployment requirements:

```text
Database migration only for the replacement/validated RPC.
No frontend deployment during RPC validation.
No Edge Function deployment.
No eBay mutation.
No Outlook mutation.
Frontend deployment happens later, separately, behind fallback/feature flag.
```

Rollback strategy:

```text
Because the restored frontend does not call the RPC, rollback is operationally simple before frontend cutover: leave the restored frontend on the old direct query, and either replace the RPC again with a fixed body or drop/ignore the versioned replacement.
After frontend cutover, rollback must be the feature flag/fallback back to the old direct query path.
```

Validation requirements:

```text
All validation gates above must pass.
The browser-auth RPC call must return nonzero rows from production mailbox data.
canonical_total must equal 300 for the current baseline.
smart_folder_counts.all must equal 300.
source counts must derive from conversation_type.
Page 2 must return additional rows.
No 42703 or P0001 can occur in the browser session.
```

## Final Decision

Use the RPC/read-model architecture, but replace the current failed implementation instead of patching it directly into frontend use.

Do not reconnect the frontend to `public.get_ebay_canonical_mailbox(...)` until the replacement RPC proves:

```text
authorized execution
nonzero rows
exact counts
valid pagination
production data correctness
browser auth correctness
safe frontend fallback
```

The next implementation should be narrow, database-only, and validation-first.
