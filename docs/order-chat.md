# Order chat entry points

Pending Orders and Packaging item cards link to `email-triage.html?orderLineId=<uuid>&from=pending|packaging` in a separate tab. The original packing work stays open. The messaging page validates the line server-side, shows its buyer and item, and provides a return link.

The existing `ebay-conversation-draft` endpoint now accepts `order_chat_context` and `start_order_chat` alongside its unchanged reply modes. Both use its existing active-employee/email-triage authorization. No new employee access is granted.

Matching is scoped to the configured seller account, member conversations, and the saved order's exact buyer username (case-insensitive, wildcard characters escaped). Confirmed line/order links and matching listing references take priority. Historical buyer/time guesses are not treated as exact matches. One exact result opens automatically; multiple results or buyer-only results are shown for the operator to choose. The chooser does not change existing order associations. Refresh chats checks the buyer's latest messages through the existing sync service.

If no exact chat is stored, staff can compose a first message for that item. Clicking the order link does not send anything. Sending uses eBay's existing OAuth and Message API transport, with `otherPartyUsername` from the stored order and a `LISTING` reference from the stored line. The recipient cannot be overridden in the request. New chats are persisted with their exact line association when eBay returns the conversation ID. An accepted response without that ID stays visibly sent/awaiting sync; no fake conversation IDs are inserted.

The additive `20261009004000_order_chat_starts.sql` migration records the first message before its provider call. Its private ledger has no anonymous/authenticated table grants. A database constraint allows at most one sending, sent, or delivery-unknown first message per line. Reusing a request key with changed text, item, or operator is rejected. Network timeouts and ambiguous server errors block automatic resend. An explicit provider rejection allows a new operator attempt. An unknown result requires checking eBay; it is never automatically reset or retried.

Validation covers identity isolation, ambiguous matches, old inferred links, concurrent submissions, first-message persistence, timeout/retry behavior, ledger constraints/RLS, and desktop/mobile/WebKit layouts. Browser fixtures never send real buyer messages.

Deployment: apply the additive migration, then update the sender index and add `_shared/ebay-order-chat.ts`. Preserve the deployed sender's existing legacy `_shared/ebay-conversation-context.ts`; its baseline differs from the repository copy. The sender index was compared against its deployed source, and only existing type annotations differed before adding these entry points. Publish the page assets after the backend is available.

API reference: https://developer.ebay.com/develop/guides/sell/sell-communications-guide
