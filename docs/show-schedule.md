# Show Studio

The recovered show scheduler lives at `seller-dashboard.html`, linked as **Show Schedule** in the admin and manager navigation. Seller sign-in still opens this page. It uses the original `seller_sale_shifts`, blocked times, approval requests, and commission workspace; no historical schedule rows are replaced.

On a phone, Week shows a seven-day picker and the selected day's show cards. Desktop Week maps platforms to rows and days to columns. Month and Agenda are available on both, with platform and seller filters. Overnight shows also appear on the following day as continuations. Times are explicitly labeled with the viewer's local timezone.

The show editor automatically assigns Airport Store for new shows and edits. There is no store selector. If the active Airport Store record is unavailable, saving stops with an error instead of assigning another location.

Managers can assign an active team member to eBay, Whatnot, or TikTok in any month. Sellers can self-book in the current store-local month. Existing near-start edit and cancellation approvals remain in place. Shows use half-hour intervals, run between two and 24 hours, and may cross midnight. Capacity is two simultaneous sellers per platform; the same seller cannot overlap across platforms. Blocks apply across sellers. Saves recheck availability on the server.

Persistent weekly patterns are stored in `seller_show_recurrences`. The daily `materialize recurring seller shows` cron extends their upcoming 90-day calendar window. Store-local times preserve daylight-saving changes; overnight shows end on the next local date. Individual edits and cancellations retain their occurrence key and never get recreated. Conflicts are recorded in `seller_show_recurrence_conflicts` and retried on the next daily run. Managers can open a repeating show and choose **Stop repeating**, which cancels future shows, pending change requests, and pending reminders for that time slot. Other recurring slots remain active. Pattern creation currently uses an authorized database operation; the editor creates individual shows.

## Release

Apply `supabase/migrations/20261113010000_show_schedule_studio.sql` and `20261113020000_show_schedule_host_reminders.sql` before releasing the frontend. They fix the month RPC's ignored argument, include month-boundary overnight rows, extend schedule channel constraints, add manager assignment, and serialize availability checks across platforms. They do not backfill, delete, or create shows.

Apply `20261113030000_recurring_seller_shows.sql` for weekly patterns and the stop-series control. The migration installs the tables, protected functions, and daily refill job; actual host patterns are configured separately.

Active employees assigned to upcoming shows or an active recurring pattern can follow the schedule link with their existing account. Their employee role and manager permissions remain unchanged.

Host reminders use the existing employee SMS system: the active worker-reminder job calls `enqueue_upcoming_shift_reminders()` every 30 seconds, which queues show reminders during the 30 minutes before a show's start. The existing `sms-dispatcher` sends them through `sms_outbox`. Each message names the assigned host, platform, store-local start/end time, studio, and schedule link. Only the host's linked `user_phones` record with `can_sms=true` is eligible; manager alert recipients are never substituted.

A unique outbox index prevents duplicate reminders for the same show/start. Changes and cancellations invalidate pending messages, and the dispatcher rechecks the current show and phone before claiming a reminder. Past shows, disabled SMS records, and inactive employees are excluded. The old generic shift reminder excludes `seller_sale` rows so hosts do not receive both versions. The editor shows readiness and a masked phone suffix, or a warning linking the needed setup to Admin → Users.

Publish `seller-dashboard.html`, `seller-dashboard.css`, `seller-dashboard.js`, `seller-schedule.js`, and `admin-nav.js`. Navigation cache versions were updated in `dashboard.html`, `admin.html`, `worker-dashboard.html`, and `live-sales.html`.

## Validation

Run `npm run test:show-schedule`. Database tests exercise assignments, month boundaries, overnight duration, cross-platform conflicts, peak capacity, blocked times, authorization, the existing approval path, reminder routing, deduplication, cancellation, opt-outs, and ordinary worker-message compatibility. Browser tests exercise 360, 390, 430, and 1440-pixel layouts, filters, navigation, create/edit/cancel, retry after failure, note escaping, SMS-readiness warnings, and a WebKit phone editor. They use isolated fixtures; no real shows or notifications are created. Preview images under `output/show-studio/` depict test fixtures.
