# Step 5F.6P.2D - Label Visibility, Smart Folder Normalization, Media Rendering

Audit date: 2026-06-08 local / 2026-06-09 UTC

## Executive Summary

Result: **PASS with deployment follow-through required.**

Implemented:

- Renamed the selected conversation card to `Conversation Labels`.
- Made the labels card open by default.
- Displayed AI Labels, System Labels, and State Labels together.
- Projected folder-driving labels visibly into the same label panel.
- Normalized all built-in saved folders to explicit `label_rules.operator = AND`.
- Added `SMART FOLDER EDIT MODE`, `Reset`, stable Save/Cancel behavior.
- Replaced custom folder chip guess-counts with exact RPC `matching_total` checks.
- Rendered stored message media as timeline thumbnails/attachments while keeping paperclip/count metadata.

Live DB built-ins were normalized through the authenticated admin app session because `supabase db push --yes` is blocked on this machine by missing `SUPABASE_ACCESS_TOKEN`. The migration file is present and still must be pushed for migration history.

## Label Audit

Live mailbox snapshot:

- Canonical conversations: `517`
- Current classifications: `514`
- Unclassified: `3`
- Unread: `11` at final audit
- Pending provider read sync: `0`
- Read sync failed: `0`

AI topic labels discovered:

| Label | Count |
|---|---:|
| general_question | 117 |
| cancellation | 104 |
| return | 100 |
| platform_notice | 93 |
| refund_request | 88 |
| shipping_issue | 82 |
| buyer_complaint | 67 |
| order_status | 51 |
| not_as_described | 41 |
| missing_item | 38 |
| item_question | 33 |
| payment_issue | 33 |
| delivery_timing | 23 |
| custom_order_question | 10 |
| feedback_issue | 7 |
| address_change | 6 |
| wrong_item | 5 |
| offer_question | 4 |

AI buyer/risk labels discovered:

| Label | Count |
|---|---:|
| new_buyer | 355 |
| repeat_buyer | 95 |
| high_value_buyer | 59 |
| low_risk_buyer | 57 |
| high_retained_value_buyer | 52 |
| vip_buyer | 52 |
| high_return_risk_buyer | 45 |
| return_prone_buyer | 19 |
| context_review_needed | 296 |
| refund_risk | 177 |
| buyer_unhappy | 121 |
| cancellation_risk | 104 |
| negative_feedback_risk | 34 |
| chargeback_risk | 9 |
| return_escalation_risk | 3 |

State/response labels discovered:

- Priority: `normal 279`, `high 132`, `low 103`
- Response: `reply_today 297`, `no_reply_needed 133`, `reply_later 84`
- Review: `pending_review 513`, `corrected 1`
- Read state: `Unread 11`, `Read 506`

Visibility repair:

- `Returns`, `Unread`, and `Has Media` were verified visible in the opened conversation label panel.
- Unread now remains visible when provider or local state is unread, even if local optimistic read handling starts.

## Folder Audit

All 16 built-ins are active and now have explicit AND label rules.

| Folder | Required label |
|---|---|
| All | none |
| Members | `system:members` |
| eBay Notifications | `system:ebay_notifications` |
| Unread | `state:unread` |
| Unclassified | `state:unclassified` |
| Returns | `system:returns` |
| Shipping | `system:shipping` |
| Reply today | `state:needs_reply_today` |
| VIP buyers | `ai:vip_buyer` |
| High value | `ai:high_value_buyer` |
| Refund risk | `ai:refund_risk` |
| Review queue | `state:review_queue` |
| Has order | `system:has_order` |
| Has return | `system:has_return` |
| Has media | `system:has_media` |
| Needs review | `system:needs_review` |

Current RPC smart counts:

`all 517`, `members 308`, `ebay_notifications 209`, `unread 11`, `unclassified 3`, `returns 114`, `shipping 136`, `needs_reply_today 297`, `vip_buyers 52`, `high_value_buyers 59`, `refund_risk 180`, `review_queue 410`, `has_order 390`, `has_return 67`, `has_media 46`, `needs_context_review 251`.

## Folder Edit UX

Before:

- Edit mode only changed the toggle to `Done`.
- No clear edit-mode banner.
- No reset-to-saved button.
- Custom folder counts could borrow the currently loaded slice and appear unstable.

After:

- Folder rail shows `SMART FOLDER EDIT MODE`.
- Draft rows expose Save, Reset, Cancel, Delete.
- Reset restores the last saved definition without saving.
- Custom folder chips use exact mailbox RPC counts or a placeholder while loading.

Validation:

- Created temporary folder `VIP Buyer + Returns`.
- Count stable before reload: `17 -> 17`.
- Removed `VIP Buyer`, reset restored it.
- Removed `VIP Buyer`, saved Returns-only.
- Count stable after save/reload: `114 -> 114`.
- Temporary audit folders were soft-deleted; final cleanup found `0` active `Audit 5F6P2D%` folders.

## Media Audit

Stored media:

- `Has Media` conversations: `46`
- `ebay_conversation_messages` rows sampled with `has_media = true`: `77`
- Rows sampled with URL-bearing `message_media`: `77`

Rendered media:

- Opened `Has Media` folder.
- Selected conversation timeline rendered image nodes: `2`
- Existing paperclip/count footer remained visible.

Implementation renders image-like media as thumbnails and non-image media as attachment links inside normal chat bubbles. Platform notification image rendering remains intact.

## Regression Results

Passed:

- `node --check email-triage.js`
- `node --check email-triage.state.js`
- Linked DB/RPC audit through authenticated app session
- Built-in saved-view normalization upsert: `16/16`
- Buyer Context direct app API check: `ok: true`, `has_context: true`
- Focused Playwright label/media/custom-folder probe
- `npm run test:email-triage`: `2 passed`
- `npm run test:ebay-notification`: `8 passed`

Playwright read-only harness covered:

- Mailbox RPC/UI counts
- Unclassified queue
- Search
- Smart folder behavior
- Selected message persistence
- Dashboard events/counts
- Read/unread state display
- Controlled send safety: blocked send attempts `0`

Skipped by default regression gates:

- Sync recent mailbox
- Refresh Timeline
- Provider read-state mutation
- Classify New
- Reclassify Recent 20
- Backfill archive
- Backfill + classify new
- Backfill + reclassify all

Linked Supabase lint:

- `node_modules/supabase/bin/supabase db lint --linked` ran, but reports pre-existing unrelated schema lint errors in older functions. No new Step 5F.6P.2D migration-specific lint issue was identified.

## Deployment Requirements

Migration required? **Yes.**

Migration file:

```text
supabase/migrations/20260609120000_email_triage_label_visibility_smart_folder_normalization.sql
```

Live saved-view data was already normalized via authenticated admin upsert. Migration history still needs:

```bash
SUPABASE_ACCESS_TOKEN=... node_modules/supabase/bin/supabase db push --yes
```

Current blocker:

```text
Access token not provided. Supply an access token by running supabase login or setting SUPABASE_ACCESS_TOKEN.
```

Edge Function deploy required? **No.**

Frontend deploy required? **Yes.**

No frontend production deploy command exists in `package.json`. Publish these static files through the current static-hosting pipeline:

```text
email-triage.html
email-triage.js
email-triage.css
email-triage.state.js
```

Local validation commands:

```bash
python3 -m http.server 4173
npm run test:email-triage
npm run test:ebay-notification
```

## Updated Beta Readiness

Current local/live-DB readiness: **92%**.

Production readiness after frontend static deploy and migration history push: **94%**.

Remaining withheld points:

- Static frontend deploy is still pending.
- Supabase migration history is not updated until an access token is available.
- Live write-gated workflows were not rerun in this pass.

## Final Decision

Can we move safely to `5F.6M - Controlled Return Messaging`?

**Yes, after publishing the frontend static files and pushing the migration with Supabase deploy auth.**

No additional stabilization step is required for label visibility, smart folder normalization, count stability, or media rendering. Do not start operator-facing controlled return messaging from stale frontend assets.
