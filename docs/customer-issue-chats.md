# Customer Issues chat shortcuts

Each case card and the top of its detail panel show a compact chat link, latest inbound message preview, timestamp and viewer-specific unread badge. It opens the existing Email Triage conversation in a new tab, preserving the case workspace. The triage page includes a return-to-case link.

`customer_issue_chat_markers` reads at most 60 case IDs per call. It requires both existing Customer Issues and Email Triage permissions. Candidates are scoped to the single active production seller account and an exact, case-insensitive buyer identity. Verified legacy buyer links are accepted only when the conversation has no conflicting username. Exact item references, order-number references and confirmed item/order links take priority. Historical buyer/time guesses are not exact matches. When only buyer-wide matches exist the card explicitly says “Same buyer · check the item.”

Multiple matched chats open the unread/latest conversation and display the count; the existing buyer inbox keeps the other conversations available. With no saved match, the link opens order chat discovery/composition where a matched local line exists, otherwise the buyer inbox. No send occurs from Customer Issues. Previews do not mark messages read, create tasks, relink orders or change case status.

Visible case IDs are batched after the cards load, so chat lookup does not delay the case list. Existing realtime conversation/message/link/read-state events refresh only chat blocks; the case list's 30-second refresh provides a fallback. Returning to the tab refreshes markers. Failed reads keep known previews with an explicit unavailable notice. Database and UI tests cover identity isolation, exact versus buyer matches, read states, permissions, bounds, escaping and stale responses.

Deployment: apply `20261010150000_customer_issue_chat_markers.sql`, then publish page assets. Existing message ingestion remains responsible for importing eBay messages; these markers update once messages reach Invsto.
