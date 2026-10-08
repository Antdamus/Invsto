# Email Triage loading and recovery

The inbox reads the canonical Supabase mailbox first. eBay ingestion runs
independently; loading the inbox is not evidence that every eBay conversation
has just been reconciled.

## Delivery paths

- Verified `NEW_MESSAGE` notifications persist before fetching the conversation.
  A notification is successful only when its expected message is stored.
  Duplicate IDs retain their original verified payload and successful status.
- `invsto-message-recovery` runs every minute. A three-minute, single-use database
  lease prevents overlapping cron workers; no service key is stored in cron.
  Each run retries up to ten failed/stalled notifications, rechecks two recent
  member conversations, and rotates through one older member conversation.
  New failures take priority over the historical backlog; the worker also stops
  starting batches after 70 seconds and lets unprocessed leases expire safely.
- Every five minutes, recovery alternates the first member-conversation page
  with a continuing archive page. Unchanged recent details are skipped.
- Failed notifications back off from two minutes to six hours. Unavailable old
  conversations have a separate backoff so they cannot block the rotation.
- Opening a conversation checks eBay in the background if its details are more
  than a minute old. Refresh explicitly checks the selected conversation.
  Visible pages refresh saved data every minute and on online/reconnect events.
  Background recovery continues with the browser closed.

Incoming notifications remain the fast path. Reconciliation is bounded and
eventual, especially for old or inaccessible conversations; it is not an
instantaneous full-account sync. Token revocation still requires reconnecting
the eBay account. The inbox shows background-check time and outstanding retries.

## Loading protections

Mailbox RLS retains its existing access rules but evaluates user authorization
once per statement. Message-body search text is built only when searching.
Timeline reads page beyond the former 200-message cutoff. Cached timelines
expire, concurrent loads are deduplicated, and responses started before a
realtime message cannot overwrite that newer message. Drafts survive refresh.
Timeouts do not launch the heavier legacy mailbox scan.

Incremental imports retain a fixed start/end window across pages, resume their
offset, overlap the previous watermark by five minutes, and advance the
watermark only after exhausting the provider result set. Order/finance sync and
classification are outside the message-recovery path. Recovery does not send
buyer replies or enqueue historical staff SMS notifications.

## Deployment and verification

1. Apply `20261009000000_email_triage_read_performance.sql` and
   `20261009001000_ebay_message_recovery.sql`.
2. Deploy `ebay-message-sync` and `ebay-message-notification`, preserving their
   existing JWT/signature configuration and the shared context module.
3. Apply `20261009002000_ebay_message_recovery_schedule.sql` and
   `20261009003000_ebay_message_recovery_priority.sql`, then publish the
   frontend. Inspect worker timestamps, recent sync runs, and retry counts.

The worker table is private. Authorized staff can read only the safe health RPC.
Avoid selecting the worker dispatch token or logging request credentials.

Tests: `message-api-reliability.test.mjs`, `message-sync-reliability.test.mjs`,
`message-recovery-database.test.mjs`, `notification-recovery.test.mjs`, and
`workspace-browser.test.mjs` under `tests/email-triage/`. Browser tests use
isolated fixtures and run in Chromium and WebKit, at 320–1920px.

Live validation on October 8, 2026: mailbox results were identical across six
folder/search samples in a rolled-back comparison. The measured mailbox RPC
fell from 4,283ms to 448ms after applying the database changes (single comparison;
end-to-end loading also includes assets, selected messages, and context).


## Chat order links

The v7 conversation context shows up to 80 recent purchases for the identified
buyer, with bounded item previews. These remain separate from chat matches and
are not added to task targets until linked. Exact username lookup ignores case
and escapes wildcard characters. Buyer/time proximity alone is a suggestion.

Staff can select one buyer order through the existing authenticated context
endpoint. The server checks the conversation participant against the order buyer,
saves an operator selection, and gives it precedence over automated suggestions.
Changing it replaces that selection; removing it marks the selection rejected
and restores the automatic context. Neither operation modifies order status,
stock, fulfillment, or buyer messages. Context reads expire after 60 seconds,
and an older in-flight read cannot overwrite a new operator selection.

Live diagnosis on October 8: geraldo3700 had 16 stored orders and luilop_10 had
13, but their unreferenced chats were ambiguous. cc-chope and el_8610 had no stored
orders under those exact usernames. A missing local order is not proof that the
buyer never purchased; it can also require an order import or identity check.
Tests: order-linking.test.mjs and the Buyer order choices browser cases.

Deploy the current shared context source with ebay-conversation-context. Only the
interactive endpoint requests buyer order choices. The existing sync, draft and
classification deployments contain older shared bundles; preserve their other
behavior with scripts/patch-deployed-order-selection.mjs until a full release of
those functions. This narrow, idempotent patch gives operator selections precedence
and keeps buyer/time-only matches suggested. Compatibility tests compare ordinary
context before/after and verify manual selection against the actual deployment
backups when available.
