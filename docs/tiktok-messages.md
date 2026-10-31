# TikTok buyer messages

`tiktok-messages.html` is the TikTok counterpart to eBay Messaging. Pending, history and cancelled TikTok orders link to it with `?order=<saved order UUID>`. The existing eBay workspace and shared navigation also link to it. Conversation permalinks use `?conversation=<saved conversation UUID>`.

Access requires an active staff record with `email_triage_access` or the admin role. Backend RPCs, RLS and the function enforce this independently of the page. TikTok tokens remain encrypted in the existing server-only connection; messaging uses the existing order worker for token renewal.

## Setup

In the existing **OG Jewelers Store** custom app, apply for **Customer Service (`seller.customer_service`)**, complete TikTok's approval requirements, and reauthorize OG Jewelers through Invsto's existing TikTok connection flow. Enabling an app scope alone does not upgrade an already-issued seller token. No additional product, financial or fulfillment scope is needed for this feature.

Deploy `tiktok-messages`, then migration `20261031180000_tiktok_messages.sql`, and publish the static files. The function performs its own staff JWT/permission validation and single-use worker lease validation, so platform `verify_jwt` is false. The cron dispatcher runs each minute; a completed inbox sweep waits five minutes. Missing permission is displayed explicitly and retried hourly. Credential refresh/reauthorization wakes the worker. Neither failed nor empty provider results delete stored conversations.

## Behavior

- Chat-to-order association uses the buyer participant's **user_id**, matched exactly to `tiktok_orders.api_buyer_id`; never `im_user_id`, display names or a guessed username.
- Reading uses GET only. This implementation never sends a TikTok message, creates/reopens a TikTok conversation, marks it read or changes agent availability. Replies stay in TikTok.
- Open / Waiting / Done are internal team statuses. New incoming buyer messages reopen them. Status saves use optimistic revisions; notes record authenticated author and time. Reading does not alter TikTok's unread count.
- Message history loads ten messages at a time, supports earlier pages, and retains already-displayed history and note drafts if a refresh fails. Media opens at its original HTTPS URL; hidden messages are excluded. Unsupported cards display an explicit fallback.
- Associated saved orders show customer identity, item titles, amounts, status, ship-by dates, tracking numbers and order/video-receipt links. No chat match is distinguished from a lack of permission.
- Chat timestamps display Eastern time. CSV order purchase times lacking a timezone retain their saved source text.

## API selection

Verified against TikTok Partner Center's current API Reference on October 31, 2026:

- [Get Conversations, 202309](https://partner.tiktokshop.com/docv2/page/get-conversations-202309): GET `/customer_service/202309/conversations`, page size 20.
- [Get Conversation Messages, 202309](https://partner.tiktokshop.com/docv2/page/get-conversation-messages-202309): GET `/customer_service/202309/conversations/{conversation_id}/messages`, page size 10.

The newer 202601 single-conversation and 202606 sending operations serve different capabilities and are not substitutions for these read endpoints. The current conversation reference adds optional session metadata beyond the bundled OAS; this reader does not request that metadata.

Validation: `node --test tests/tiktok-messages*.test.mjs`, existing TikTok order browser regressions, and `deno check --no-lock supabase/functions/tiktok-messages/index.ts`.
