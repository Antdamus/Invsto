# Step 5F.6N Outlook Retirement Audit

Audit date: 2026-06-02

Scope: repository audit only. No production behavior, code paths, migrations, Edge Functions, database objects, Outlook state, eBay state, secrets, or tokens were changed.

## Executive Summary

Yes, the platform can operate entirely without Outlook for the current eBay-first workflow.

The current eBay workflow has its own canonical data path:

```text
eBay Messages
-> Supabase canonical conversation tables
-> AI classification
-> Smart folders/search
-> AI drafts/manual composer
-> Controlled eBay send
-> eBay message audit/dashboard
```

No Outlook/Microsoft runtime artifact is required for that workflow.

However, Outlook has not been fully retired in the repository yet. The `email-triage.html` page still contains Outlook controls and hidden legacy mailbox panels, `email-triage.api.js` still calls Microsoft Edge Functions, the operations dashboard still mixes eBay metrics with legacy mailbox pipeline checks, and the database still contains Microsoft token tables plus the full legacy email mailbox/classification/draft schema.

The main decommission risk is database coupling: `ebay_conversation_links.email_message_id` still references `public.email_messages`, and `ebay_conversation_links.link_type` still allows `outlook_email`. That bridge must be removed, archived, or migrated before dropping legacy email tables.

Recommendation:

```text
Proceed with 5F.6Q Outlook Decommission now,
but do it as a controlled cleanup sequence.
Do not drop legacy email tables before removing the eBay link FK/column
and deciding whether imported Outlook evidence should be exported/archived.
```

## Current Answer

Can Outlook be removed?

```text
Yes.
```

Can the platform operate entirely without Outlook?

```text
Yes, for the proven eBay-first messaging, classification, draft, send, audit,
and dashboard workflow.
```

Is the repo already Outlook-free?

```text
No.
```

The repo still contains active Outlook UI, Microsoft Edge Functions, Microsoft OAuth tables, legacy email tables, legacy classification/draft tools, and dashboard references.

## Inventory

### Outlook UI And Pages

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Evidence Mailbox toolbar | `email-triage.html:52`, `email-triage.js:640` | Shows mailbox connection state, mailbox email, last checked. | Yes, page init writes to it. | No. | Yes, after replacing with eBay account/sync status or removing the toolbar. | Low | REMOVE |
| Connect/Disconnect Outlook buttons | `email-triage.html:225`, `email-triage.js:6664` | Starts Microsoft OAuth and deletes stored server-side refresh token. | Yes, inside admin diagnostics drawer. | No. | Yes, after removing auth calls. | Low | REMOVE |
| Mailbox Details panel | `email-triage.html:235`, `email-triage.js:6182` | Shows Microsoft connection status and errors. | Yes, loaded on page init. | No. | Yes, after removing page init status check. | Medium | REMOVE |
| Outlook Preview panel | `email-triage.html:250`, `email-triage.inbox.js:718` | Previews latest Outlook emails from Microsoft Graph. | Yes, admin diagnostic action. | No. | Yes. | Low | REMOVE |
| Mailbox Import / Prepare panel | `email-triage.html:325`, `email-triage.inbox.js:823` | Imports Outlook messages into legacy email tables and prepares/classifies them. | Yes, admin diagnostic action. | No. | Yes, after legacy tables/functions are retired. | Medium | REMOVE |
| Rematch Tools panel | `email-triage.html:389`, `email-triage.inbox.js:1072` | Rematches deterministic links for imported emails. | Yes, admin diagnostic action. | No for canonical eBay conversations. | Yes, after removing email matcher bridge. | Medium | REMOVE |
| Raw Outlook Preview panel | `email-triage.html:427`, `email-triage.js:6243` | Shows latest sanitized Graph message previews. | Yes, auto-loaded when Outlook connected. | No. | Yes. | Low | REMOVE |
| Legacy email classification debug pane | `email-triage.html:462`, `email-triage.js:5736` | Lists durable mailbox classifications and selected email details. | Yes, still loaded through `microsoft-email-classify admin_view`. | No. | Yes, after deleting legacy classification features. | Medium | REMOVE |
| Legacy email CSS classes | `email-triage.css:8`, `email-triage.css:2538`, `email-triage.css:2599` | Styles mailbox toolbar, email tables, email body/detail panels. | Yes, supports legacy panels. | No. | Yes, after UI removal. | Low | REMOVE |
| Admin/dashboard pages outside email-triage | `admin*.js/html`, `dashboard*.js/html`, `seller-dashboard.*`, `worker-dashboard.*` | Search found no Outlook/Microsoft runtime references. | No. | No. | Nothing to remove. | Low | KEEP |

### Frontend API And Runtime Calls

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Microsoft function constants | `email-triage.api.js:4` | Names Microsoft auth/status/sync/classify/process functions. | Yes. | No. | Yes, after removing callers. | Medium | REMOVE |
| Mailbox status bootstrap | `email-triage.js:6734` | Calls `microsoft-mailbox-status` on page init and may auto-load latest messages. | Yes. | No. | Yes, but remove after replacing status UI. | Medium | REMOVE |
| Latest message load | `email-triage.js:6258`, `email-triage.api.js:5` | Calls `microsoft-latest-messages`. | Yes when Outlook is connected. | No. | Yes. | Low | REMOVE |
| Microsoft OAuth start | `email-triage.js:6298`, `email-triage.api.js:4` | Redirects to Microsoft login. | Yes by button. | No. | Yes. | Low | REMOVE |
| Microsoft disconnect | `email-triage.js:6322`, `email-triage.api.js:7` | Deletes Microsoft connection secret. | Yes by button. | No. | Yes. | Low | REMOVE |
| Legacy email classification API | `email-triage.api.js:330` | Calls `microsoft-email-classify` for `admin_view`, `message_detail`, draft view, draft actions, match actions, review actions. | Yes. | No. | Yes, after removing hidden legacy classification pane. | Medium | REMOVE |
| Outlook preview/import API | `email-triage.api.js:904`, `email-triage.api.js:923`, `email-triage.api.js:936` | Calls `microsoft-email-sync` for preview/import/mailbox import. | Yes. | No. | Yes. | Medium | REMOVE |
| Prepare/live refresh API | `email-triage.api.js:964`, `email-triage.api.js:979` | Calls `microsoft-email-sync` for legacy processing/classification orchestration. | Yes. | No. | Yes. | Medium | REMOVE |
| Rematch existing emails API | `email-triage.api.js:996` | Calls `microsoft-email-process` for email link rematch. | Yes. | No. | Yes, after bridge removal. | Medium | REMOVE |
| Operations dashboard legacy calls | `email-triage.api.js:2029` | Calls Microsoft mailbox status plus legacy pipeline/live sync diagnostics, then eBay dashboard. | Yes. | No for eBay workflow. | Yes, after dashboard becomes eBay-only. | Medium | REMOVE |
| Outlook error messages | `email-triage.render-utils.js:206` | Human-readable Microsoft/Outlook error copy. | Yes. | No. | Yes. | Low | REMOVE |
| Outlook safety labels in diagnostics | `email-triage.diagnostics.js:180`, `email-triage.diagnostics.js:430`, `email-triage.diagnostics.js:648` | Shows "Outlook mutation/fetch" safety fields in legacy and eBay dashboards. | Yes. | No. | Optional; can stay briefly as safety metadata, but remove for complete retirement. | Low | OPTIONAL |

### Outlook Edge Functions

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `microsoft-auth-start` | `supabase/functions/microsoft-auth-start/index.ts` | Builds Microsoft OAuth authorization URL. | Called by frontend. | No. | Yes, after removing Connect Outlook UI. | Low | REMOVE |
| `microsoft-auth-callback` | `supabase/functions/microsoft-auth-callback/index.ts`, `supabase/config.toml:546` | Exchanges OAuth code, calls Graph `/me`, stores connection and encrypted refresh token. | Used by OAuth redirect if active. | No. | Yes, after disabling OAuth flow. | Medium | REMOVE |
| `microsoft-mailbox-status` | `supabase/functions/microsoft-mailbox-status/index.ts`, `supabase/config.toml:551` | Reads `microsoft_mailbox_connections` status. | Called on page init and dashboard. | No. | Yes, after frontend cleanup. | Medium | REMOVE |
| `microsoft-mailbox-disconnect` | `supabase/functions/microsoft-mailbox-disconnect/index.ts`, `supabase/config.toml:556` | Deletes stored refresh token and marks connection disconnected. | Called by Disconnect Outlook. | No. | Yes, after final token cleanup. | Low | REMOVE |
| `microsoft-latest-messages` | `supabase/functions/microsoft-latest-messages/index.ts` | Refreshes token and calls Graph `/me/messages` for preview rows. | Called by frontend, but not listed in current `supabase/config.toml`. | No. | Yes. | Low | REMOVE |
| `microsoft-email-bootstrap` | `supabase/functions/microsoft-email-bootstrap/index.ts`, `supabase/config.toml:561` | Bootstraps mailbox/folder/sync state from Graph inbox. | Registered, no current frontend call found. | No. | Yes. | Low | REMOVE |
| `microsoft-email-sync` | `supabase/functions/microsoft-email-sync/index.ts`, `supabase/config.toml:566` | Graph preview, approved import, mailbox import, prepare mailbox, live refresh, diagnostics. | Called by UI and dashboard. | No. | Yes, after UI/dashboard cleanup. | Medium | REMOVE |
| `microsoft-email-process` | `supabase/functions/microsoft-email-process/index.ts`, `supabase/config.toml:571` | Normalizes/processes imported emails and rematches deterministic links. | Called by rematch UI. | No. | Yes, after removing email matcher bridge. | Medium | REMOVE |
| `microsoft-email-classify` | `supabase/functions/microsoft-email-classify/index.ts`, `supabase/config.toml:576` | Legacy email AI classification, draft generation, reviews, message detail, replay/repair diagnostics. | Called by hidden legacy pane and regression tool. | No. | Yes, after eBay draft/classification is canonical. | Medium | REMOVE |
| `microsoft-email-ops` | `supabase/functions/microsoft-email-ops/index.ts`, `supabase/config.toml:581` | Legacy mailbox health, queue status, replay/requeue controls. | Registered, no current frontend call found. | No. | Yes. | Low | REMOVE |

### Microsoft Authentication And Secrets

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Microsoft OAuth env names | Microsoft functions reference `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`, `MICROSOFT_GRAPH_SCOPES`, `MICROSOFT_AUTHORITY_HOST`, `MICROSOFT_GRAPH_BASE_URL`. | Enables Microsoft OAuth and Graph calls. | Yes by functions. | No. | Yes, after function removal and hosted secret cleanup. | Medium | REMOVE |
| Token encryption env names | `MICROSOFT_TOKEN_ENCRYPTION_KEY`, `MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION` in auth/sync/latest/bootstrap functions. | Encrypts/decrypts refresh token secrets. | Yes by functions. | No. | Yes, after deleting token rows and functions. | Medium | REMOVE |
| Stored Microsoft connection metadata | `microsoft_mailbox_connections` | Stores mailbox identity, Microsoft user id, status, scopes, token expiry, errors. | Yes by status/latest/sync/bootstrap. | No. | Yes, after data retention decision. | Medium | REMOVE |
| Stored Microsoft refresh token secret | `microsoft_mailbox_connection_secrets` | Stores encrypted refresh token ciphertext, iv, key version. | Yes by latest/sync/bootstrap/callback. | No. | Yes, after revocation/export decision. | High because it contains token material | REMOVE |

No local `.env` file with Microsoft values was found in the repository scan. The audit searched by secret name only and did not read hosted Supabase secrets.

### Outlook Database Tables

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `email_mailboxes` | `supabase/migrations/20260520143000_email_triage_persistence_foundation.sql:6` | Legacy provider-neutral mailbox record; references Microsoft connection. | Yes by Microsoft functions. | No. | Yes, after function/UI removal. | Medium | REMOVE |
| `email_folders` | `...persistence_foundation.sql:24` | Legacy mailbox folders. | Yes by sync/bootstrap. | No. | Yes. | Low | REMOVE |
| `email_messages` | `...persistence_foundation.sql:40` | Imported Outlook/Gmail-style message metadata and Graph ids. | Yes by legacy functions and eBay FK. | No, but currently referenced by eBay bridge. | Yes only after removing `ebay_conversation_links.email_message_id`. | High | REMOVE |
| `email_message_recipients` | `...persistence_foundation.sql:80` | Recipients for imported emails. | Yes by sync/process/classify. | No. | Yes. | Medium | REMOVE |
| `email_message_bodies` | `...persistence_foundation.sql:93` | Stored body text/html/normalized text. | Yes by sync/process/classify. | No. | Yes, after archive decision. | Medium | REMOVE |
| `email_attachments` | `...persistence_foundation.sql:109` | Email attachment metadata. | Schema exists; no current eBay need. | No. | Yes. | Low | REMOVE |
| `email_sync_states` | `...persistence_foundation.sql:131` | Graph delta/sync checkpoint state. | Yes by sync/bootstrap. | No. | Yes. | Medium | REMOVE |
| `email_sync_runs` | `...persistence_foundation.sql:153` | Legacy mailbox sync run audit. | Yes by sync/bootstrap/ops. | No. | Yes, after audit retention decision. | Medium | REMOVE |
| `email_processing_jobs` | `...persistence_foundation.sql:179` | Legacy normalize/match/classify/draft queue. | Yes by sync/process/classify/ops. | No. | Yes. | Medium | REMOVE |
| `email_message_classifications` | `...persistence_foundation.sql:203`, modified by later email migrations. | Legacy message-level AI classification. | Yes by classify UI/function. | No. | Yes. | Medium | REMOVE |
| `email_message_links` | `...persistence_foundation.sql:221` | Deterministic links between imported emails and eBay/order/inventory context. | Yes by email matcher/rematch. | No for canonical eBay. | Yes after moving any needed links into eBay conversation links or discarding. | Medium | REMOVE |
| `email_operational_events` | `supabase/migrations/20260520170000_email_triage_operational_events.sql:4` plus later event-type migrations. | Legacy email import/process/classify/replay audit feed. | Yes by dashboard/functions. | No. | Yes, after audit retention decision. | Medium | REMOVE |
| `email_classification_review_events` | `supabase/migrations/20260521200000_email_triage_classification_review_overrides.sql:87` | Legacy review event history. | Yes by classify review flow. | No. | Yes. | Low | REMOVE |
| `email_response_drafts` | `supabase/migrations/20260522120000_email_triage_response_draft_persistence.sql:5` | Legacy AI response drafts for imported emails. | Yes by classify/draft tooling and regression script. | No. | Yes, after confirming eBay draft tables are canonical. | Medium | REMOVE |

### Legacy Classification, Draft, And Smart Folder Artifacts

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Legacy email categories | `email-triage.classifications.js:4` | Email/message-level classification categories like `shipping_label`, `refund_request`, `spam_or_noise`. | Yes by hidden legacy pane. | No. | Yes. | Low | REMOVE |
| Legacy category groups and filters | `email-triage.classifications.js:27`, `email-triage.html:462` | Mailbox classification navigation, filters, density. | Yes. | No. | Yes. | Low | REMOVE |
| Legacy email draft UI/copy | `email-triage.drafts.js:4`, `email-triage.js:1554` | Draft review messages for imported email drafts. | Yes in legacy detail pane. | No. | Yes. | Low | REMOVE |
| Legacy message detail/thread blocks | `email-triage.js:1097`, `email-triage.js:1243` | Stored Outlook body/thread rendering. | Yes in legacy detail pane. | No. | Yes. | Low | REMOVE |
| Legacy draft regression tool | `tools/email-triage/run-draft-regression-checks.js:4`, `tools/email-triage/README.md:19` | Runtime harness for `microsoft-email-classify` email draft invariants. | Optional developer tool only. | No. | Yes, after eBay draft regression coverage exists. | Low | REMOVE |

### Dashboard Elements

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mixed operations dashboard fetch | `email-triage.api.js:2029` | Fetches Microsoft mailbox status, legacy pipeline diagnostics, legacy live sync status, and eBay dashboard. | Yes. | No for eBay. | Yes, after eBay-only dashboard fetch. | Medium | REMOVE |
| Legacy mailbox dashboard renderer | `email-triage.diagnostics.js:668` | Renders Mailbox Status, Queue Health, Pipeline Visibility, Event-Derived Gaps for email pipeline when no eBay snapshot exists. | Yes as fallback. | No. | Yes. | Low | REMOVE |
| eBay dashboard safety field mentioning Outlook | `email-triage.diagnostics.js:648` | Displays `Outlook mutation: false` in eBay safety flags. | Yes. | No. | Optional; remove for full retirement. | Low | OPTIONAL |
| Legacy operational event descriptions | `email-triage.diagnostics.js:180` | Describes `sync_import_approved`, `run_live_refresh`, `process_imported`, `classify_imported`. | Yes when old events are shown. | No. | Yes after old events are not rendered. | Low | REMOVE |

### eBay-Side Outlook Residue

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ebay_conversation_links.link_type = 'outlook_email'` | `supabase/migrations/20260528120000_ebay_canonical_messaging.sql:136`, `supabase/functions/_shared/ebay-conversation-context.ts:18` | Allows a canonical eBay conversation link to point to Outlook evidence. | Possible, depending on data. | No. | Yes, after archiving/updating existing rows. | High if rows exist | REMOVE |
| `ebay_conversation_links.email_message_id` FK | `supabase/migrations/20260528120000_ebay_canonical_messaging.sql:142`, `supabase/functions/_shared/ebay-conversation-context.ts:1010` | Foreign key from eBay conversation links to legacy `email_messages`. | Possible, and blocks table drop. | No. | Yes, after migration removes FK/column or archives values. | High | REMOVE |
| `outlook_relay` send provider enum | `supabase/migrations/20260601183000_ebay_message_audit_operations.sql:43` | Allows future/legacy send attempt provider value. | No code reference found beyond migration. | No. | Yes, if no fallback relay is planned. | Low | OPTIONAL |
| eBay safety metadata | `supabase/functions/ebay-conversation-draft/index.ts:767`, `supabase/functions/ebay-message-sync/index.ts:1068`, `supabase/functions/ebay-conversation-classify/index.ts:399` | Explicitly marks Outlook mutations/classification as disallowed or false. | Yes as safety metadata/copy. | No. | Optional; can remain until vocabulary cleanup. | Low | OPTIONAL |
| `ebay-message-probe` notes | `supabase/functions/ebay-message-probe/index.ts:1067` | Audit/probe notes say Outlook is not required for canonical chat. | No production path. | No. | Keep as historical probe unless docs cleanup. | Low | OPTIONAL |

### Historical Docs

| Dependency | Location | Purpose | Still Used? | Required? | Safe To Remove? | Removal Risk | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Prior Outlook/Email Triage audit docs | `docs/email-triage/*.md` | Historical record of Microsoft Graph POC and email-triage buildout. | No runtime use. | Not required for app behavior. | Could be removed, but should be kept as project history. | Low | OPTIONAL |

## Risk Assessment

### High Risk

1. `ebay_conversation_links.email_message_id` references `email_messages`.
   - Dropping `email_messages` first would fail or require cascading changes.
   - Proposed fix: archive or delete `outlook_email` link rows, remove the FK/column, and tighten the `link_type` constraint before dropping email tables.

2. Microsoft refresh token storage.
   - `microsoft_mailbox_connection_secrets` contains encrypted token material.
   - Proposed fix: intentionally revoke/delete secrets during decommission and remove hosted Microsoft secrets after code no longer uses them.

3. Data retention for imported mailbox evidence.
   - Legacy Outlook rows may contain useful historical audit/debug evidence.
   - Proposed fix: decide whether to export/archive before dropping tables.

### Medium Risk

1. Page initialization still calls legacy Microsoft functions.
   - Removing functions before frontend cleanup will create avoidable UI errors.

2. Operations dashboard still mixes eBay and legacy mailbox diagnostics.
   - Removing Microsoft functions first will make dashboard status noisy.

3. Legacy email classification/draft state still has a developer regression tool.
   - Remove or replace with eBay-native draft/classification regression coverage.

4. `microsoft-email-sync` internally invokes `microsoft-email-classify`.
   - These functions should be removed as a batch, not one at a time.

### Low Risk

1. Outlook labels, CSS classes, and messages.
2. Microsoft function config blocks in `supabase/config.toml`.
3. `outlook_mutation_performed: false` safety copy.
4. Historical docs.

## Proposed 5F.6Q Outlook Decommission Plan

### Removal Order

1. Preflight and freeze.
   - Confirm no operator is actively using Outlook preview/import/classification panels.
   - Confirm current eBay conversations, notifications, AI classification, smart folders, drafts, controlled sending, audit trail, and dashboard still work.
   - Search again for `microsoft`, `outlook`, `email_messages`, `email_response_drafts`, and `email_operational_events`.

2. Remove Outlook UI from `email-triage.html`.
   - Remove Evidence Mailbox toolbar or replace it with eBay account/sync status.
   - Remove Connect/Disconnect Outlook controls.
   - Remove Mailbox Details, Outlook Preview, Mailbox Import / Prepare, Rematch Tools, Raw Outlook Preview, and legacy classification debug panels.

3. Remove frontend Microsoft runtime calls.
   - Remove Microsoft constants and functions from `email-triage.api.js`.
   - Remove page init mailbox status/latest-message bootstrap from `email-triage.js`.
   - Remove legacy classification/draft/match handlers tied to imported emails.
   - Remove legacy inbox import/rematch state from `email-triage.state.js` and `email-triage.inbox.js`.
   - Remove Outlook error copy from `email-triage.render-utils.js`.
   - Remove old Outlook dashboard labels from `email-triage.diagnostics.js`.

4. Convert operations dashboard to eBay-only.
   - Keep eBay metrics from `ebay_conversations`, `ebay_conversation_classifications`, `ebay_conversation_response_drafts`, `ebay_message_approvals`, `ebay_message_send_attempts`, and `ebay_message_activity_events`.
   - Stop calling `microsoft-mailbox-status` and `microsoft-email-sync` dashboard modes.
   - Remove mailbox/pipeline cards.

5. Remove eBay-to-email bridge dependency.
   - Inspect existing `ebay_conversation_links` rows where `link_type = 'outlook_email'` or `email_message_id is not null`.
   - If any rows exist, export or copy their audit value into metadata before removing the FK.
   - Add a migration that drops the `email_message_id` FK/column or makes it independent of `email_messages`.
   - Update the `link_type` check to remove `outlook_email`.
   - Update `_shared/ebay-conversation-context.ts` to remove `outlook_email` and `email_message_id`.

6. Remove Microsoft Edge Functions and config.
   - Delete `supabase/functions/microsoft-auth-start`.
   - Delete `supabase/functions/microsoft-auth-callback`.
   - Delete `supabase/functions/microsoft-mailbox-status`.
   - Delete `supabase/functions/microsoft-mailbox-disconnect`.
   - Delete `supabase/functions/microsoft-latest-messages`.
   - Delete `supabase/functions/microsoft-email-bootstrap`.
   - Delete `supabase/functions/microsoft-email-sync`.
   - Delete `supabase/functions/microsoft-email-process`.
   - Delete `supabase/functions/microsoft-email-classify`.
   - Delete `supabase/functions/microsoft-email-ops`.
   - Remove Microsoft function blocks from `supabase/config.toml`.

7. Remove legacy tools.
   - Delete or retire `tools/email-triage/run-draft-regression-checks.js`.
   - Replace with eBay-native classification/draft regression tests if needed.

8. Remove legacy database schema with a dedicated migration.
   - After export/retention decision, drop dependent tables first:

```text
email_response_drafts
email_classification_review_events
email_operational_events
email_message_links
email_message_classifications
email_processing_jobs
email_sync_runs
email_sync_states
email_attachments
email_message_bodies
email_message_recipients
email_messages
email_folders
email_mailboxes
microsoft_mailbox_connection_secrets
microsoft_mailbox_connections
```

9. Remove hosted Microsoft secrets.
   - Remove `MICROSOFT_CLIENT_ID`.
   - Remove `MICROSOFT_CLIENT_SECRET`.
   - Remove `MICROSOFT_TENANT_ID`.
   - Remove `MICROSOFT_REDIRECT_URI`.
   - Remove `MICROSOFT_GRAPH_SCOPES`.
   - Remove `MICROSOFT_AUTHORITY_HOST` if set.
   - Remove `MICROSOFT_GRAPH_BASE_URL` if set.
   - Remove `MICROSOFT_TOKEN_ENCRYPTION_KEY`.
   - Remove `MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION`.

10. Verification.
   - Run `rg -n -i "microsoft|outlook|graph|mailbox|email_messages|email_response_drafts|email_operational_events"` and review any remaining hits.
   - Run `git diff --check`.
   - Exercise eBay conversation sync, classification, smart folders, search, draft generation, manual compose, controlled send, audit trail, and dashboard.

### Migration Considerations

- Do not drop legacy tables before removing `ebay_conversation_links.email_message_id`.
- Decide whether imported Outlook bodies/metadata should be archived for compliance or debugging.
- If preserving historical evidence, export it outside the active operational schema rather than keeping Microsoft auth/runtime code alive.
- If any `outlook_email` eBay conversation links exist, either delete them or preserve the old email reference as inert JSON metadata before removing the FK.
- Removing `outlook_relay` from `ebay_message_send_attempts.provider` is optional. If no fallback relay plan remains, tighten the provider check.
- Remove Microsoft secrets after code/function deletion, not before, to avoid partial-deploy failures during the decommission.

## Recommendation

Outlook should be removed from the eBay operator workflow now.

It does not need to wait for:

```text
5F.6O Historical Backfill + Incremental Sync
5F.6P Live Sync / Near-Real-Time Refresh
5F.6M Controlled Return Message Send
```

Those should be built eBay-native. Keeping Outlook around for those steps would reintroduce the old mailbox-derived model after the eBay-first path has already proven read, sync, context, classification, drafts, sending, audit, and dashboard.

The safest path is:

```text
5F.6Q now:
remove Outlook UI/calls/functions/config,
remove or archive the eBay email bridge,
then drop legacy Microsoft/email tables after a retention decision.
```

