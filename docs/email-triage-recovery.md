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
  Each run retries up to three failed/stalled notifications, rechecks two recent
  member conversations, and rotates through one older member conversation.
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
3. Apply `20261009002000_ebay_message_recovery_schedule.sql`, then publish the
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
