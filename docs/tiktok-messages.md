# TikTok buyer messages

`tiktok-messages.html` is the TikTok counterpart to eBay Messaging. Pending, history and cancelled TikTok orders link to it with `?order=<saved order UUID>`. The existing eBay workspace and shared navigation also link to it. Conversation permalinks use `?conversation=<saved conversation UUID>`.

Access requires an active staff record with `email_triage_access` or the admin role. Backend RPCs, RLS and the function enforce this independently of the page. TikTok tokens remain encrypted in the existing server-only connection; messaging uses the existing order worker for token renewal.

## Setup

In the existing **OG Jewelers Store** custom app, apply for **Customer Service (`seller.customer_service`)**, complete TikTok's approval requirements, and reauthorize OG Jewelers through Invsto's existing TikTok connection flow. Enabling an app scope alone does not upgrade an already-issued seller token. No additional product, financial or fulfillment scope is needed for this feature.

Apply the chat migrations, including `20261031193000_tiktok_chat_replies.sql`, deploy `tiktok-messages`, then publish the static files. The function performs its own staff JWT/permission validation and single-use worker lease validation, so platform `verify_jwt` is false. The cron dispatcher runs each minute; a completed inbox sweep waits five minutes. Missing permission is displayed explicitly and retried hourly. Credential refresh/reauthorization wakes the worker. Neither failed nor empty provider results delete stored conversations.

## Behavior

- TikTok pending orders, history and cancellations display blue **Buyer chat · history** badges and amber **Buyer chat · N unread** badges, with an amber accent on affected item lines and buyer cards. These are buyer-wide conversations, matched by exact API buyer ID within the connected shop. Counts are TikTok's shared shop unread counts, not personal Invsto read receipts. Duplicate orders for the same buyer do not multiply the count. Missing buyer IDs and unavailable/delayed sync are shown explicitly.
- The compact `list_tiktok_order_chat_markers` RPC requires inventory and messaging access and accepts at most 500 saved order IDs. It returns no message contents. Apply `20261031210000_tiktok_order_chat_markers.sql` before publishing the queue assets. Realtime updates plus visible-page polling every 20 seconds and focus/online refresh decorate existing cards without resetting selections, notes or dialogs. New messages appear after the existing TikTok sync receives them; merely opening the queue never marks them read. A badge opens the matching chat in another tab and preserves the order context.
- Chat-to-order association uses the buyer participant's **user_id**, matched exactly to `tiktok_orders.api_buyer_id`; never `im_user_id`, display names or a guessed username.
- Staff can send text (2,000 characters), photos (JPG/PNG/GIF/WebP, up to 10 MB), and order cards for this exact buyer. Photos are previewed locally and uploaded to TikTok only when Send photo is clicked. Arbitrary order IDs and external image URLs are not accepted from the client. General file/PDF and video uploading are not implemented.
- `Buyer chat & reply` opens the workspace from an order. `Start buyer chat` creates the conversation when none is synced. `Reopen chat` explicitly reopens an existing conversation; TikTok enforces eligibility. `Mark read in TikTok` is explicit; merely viewing or sending does not mark messages read or change agent availability.
- Every send has a permanent request UUID, authenticated staff name/time, canonical payload fingerprint, and provider receipt. A conversation row lock serializes sends. Repeated requests and recent identical content reuse the receipt. Accepted means TikTok returned a message ID, not that the buyer read it. Accepted messages appear immediately, deduplicated against provider history.
- A timeout, malformed receipt or server error after dispatch becomes **unconfirmed**, never an automatic retry. The draft is retained; Check send status only checks the saved receipt. Staff must inspect TikTok and explicitly record “not sent” before releasing an ambiguous identical reply. Clear provider rejections permit a new deliberate attempt. An upload failure cannot send a buyer message. If TikTok accepts a reply but local receipt persistence fails, the response still shows acceptance and warns against resending.
- Open / Waiting / Done are internal team statuses. New incoming buyer messages reopen them. Status saves use optimistic revisions; notes record authenticated author and time. Reading does not alter TikTok's unread count.
- Message history loads ten messages at a time, supports earlier pages, and retains already-displayed history and note drafts if a refresh fails. The active conversation refreshes every 15 seconds when visible and idle; typing and reading older pages are preserved. Reply drafts and pending request IDs are saved per staff user in this tab’s session storage. A selected photo is memory-only and may need reselection after a reload. Media opens at its original HTTPS URL; hidden messages are excluded. Unsupported cards display an explicit fallback.
- Associated saved orders show customer identity, item titles, amounts, status, ship-by dates, tracking numbers and order/video-receipt links. No chat match is distinguished from a lack of permission.
- Chat timestamps display Eastern time. CSV order purchase times lacking a timezone retain their saved source text.

## API selection

Verified against TikTok Partner Center's current API Reference on October 31, 2026:

- [Get Conversations, 202309](https://partner.tiktokshop.com/docv2/page/get-conversations-202309): GET `/customer_service/202309/conversations`, page size 20.
- [Get Conversation Messages, 202309](https://partner.tiktokshop.com/docv2/page/get-conversation-messages-202309): GET `/customer_service/202309/conversations/{conversation_id}/messages`, page size 10.

- [Send Message, 202606](https://partner.tiktokshop.com/docv2/page/send-message): POST `/customer_service/202606/conversations/{conversation_id}/messages`. This newer version is absent from the bundled OAS (which has 202309). Its current official JSON `type` and serialized `content` schema is used; no undocumented sender fields are added.
- [Upload Image for Buyer Messages, 202309](https://partner.tiktokshop.com/docv2/page/upload-image-for-buyer-messages-202309): POST `/customer_service/202309/images/upload`, multipart `data`. Signing excludes the multipart body; the returned URL and dimensions become the IMAGE content.
- [Mark Buyer Messages as Read, 202309](https://partner.tiktokshop.com/docv2/page/mark-buyer-messages-as-read-202309): POST `/customer_service/202309/conversations/{conversation_id}/messages/read`.
- [Create Conversation, 202309](https://partner.tiktokshop.com/docv2/page/create-conversation-202309): POST `/customer_service/202309/conversations` with saved exact `buyer_user_id`. Existing conversations retain their ID.

The 202601 single-conversation operation serves a different capability and is not a replacement for either list/read operation. The current conversation reference adds optional session metadata beyond the bundled OAS; this reader does not request that metadata. [Conversation eligibility and platform behavior](https://partner.tiktokshop.com/docv2/page/customer-service-api-overview) remain enforced by TikTok. No reply is sent automatically on page load or by the sync worker.

Validation: `node --test tests/tiktok-messages*.test.mjs`, existing TikTok order browser regressions, and `deno check --no-lock supabase/functions/tiktok-messages/index.ts`.
