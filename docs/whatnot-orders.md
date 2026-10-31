# Whatnot orders

`pending-whatnot-orders.html` is an independent, staff-only Whatnot workspace. Its marketplace tab appears beside eBay and TikTok. No Whatnot record or action writes to either marketplace's tables.

## Connection and sync

An active Invsto administrator connects **ogjewelers** using a Whatnot personal access token with **Read orders**, **Read shipments**, **Read customers**, and **Read shows**. The browser sends the token only to `whatnot-order-sync`, clears the form, and never persists it. The server checks `/users/me`, pins the seller identity, and AES-GCM encrypts the token with `WHATNOT_TOKEN_ENCRYPTION_KEY` (base64 32 bytes). Credentials and worker leases are service-role-only; status responses exclude them. A different seller cannot replace the account. Pausing stops importing, but revoking the credential is done in Whatnot.

The official Seller API v2 is the sole order source. Initial sync walks every order page without a date cutoff. Each order's items are fully paginated. Each item's own `shipment_id` supplies its tracking, shipment state and due day. Replacement shipment IDs never imply item coverage. Imports preserve staff notes, missing/CGL flags, receipt links and completion evidence. Changed quantity, package, tracking or shipment holds reopen previously completed work for review.

After backfill, recent orders and older pending work are checked every five minutes, with a full history reconciliation every six hours. The minute scheduler resumes history pages using a single-use lease. Failed pages do not advance the cursor; already imported orders are safe to repeat. A visible status distinguishes full history still importing, successful updates, errors, paused sync and token expiry. Rate-limited or temporarily unavailable API requests retry with backoff. The integration never purchases labels, changes Whatnot orders, refunds a buyer, or deducts inventory.

## Queue and evidence

Buyers group by Whatnot buyer ID; missing IDs stay isolated by order. Search accepts username, customer name, title, order number, full or partial tracking. The camera scanner is available on a phone. Filters and their counts use the selected view and search, and show only matching lines. “Show buyer’s other items” explicitly expands the group.

`pending` and `failed` payments, pending cancellations, shipment action requirements and unresolved replacement shipments appear in **Needs review**. Initially imported completed/shipped records are marked **Imported marketplace history**, not falsely attributed to Invsto staff. Existing pending work does not silently close when a later API update says shipped. Whatnot cancellation status goes to history; no refund amount is inferred from cancellation.

Shipping deadlines are the seller-local due **calendar day**, which the official API serializes at midnight. That midnight is not treated as the overdue cutoff. Queue calendar comparisons use America/New_York. Missing dates are shown as unknown.

Staff can select exact lines to add attributed/timestamped notes, mark missing/found or CGL pending/ready, save photos, and attach verified label PDFs. Completion requires eligible payment/status, no missing/CGL/marketplace holds, tracking, a saved label whose snapshot covers that tracking and quantity, completion photos covering the current quantity, and explicit physical review. Other lines remain open. Admin reopening requires a reason. These actions are internal fulfillment records; they do not debit stock or assert carrier handoff. All writes check permissions and line revisions. Evidence files stay in the private `whatnot-order-evidence` bucket.

## Video receipts and reports

The API supplies the exact seller order URL but no video-receipt URL, ship-to street address, refund ledger, seller fees, or full carrier scan history. The UI does not fabricate these fields. A live-sale line's receipt control opens its exact order; choose **View Receipt** in Whatnot. OG eBay Order Link **1.0.25** opens that control automatically from Invsto's receipt link and adds a cropped-frame capture button. It verifies the visible order identity, the exact item supplied by Invsto, active source tab, and the saved destination order URL. Transfers expire after one hour; successful saves clear the image from extension storage. No raw video is retained. Open the Whatnot workspace before capturing.

Saved receipt URLs can also be recorded per item. Several photos may attach to each line and open full size. Shown-items reports and full buyer-history reports include customer identity, item index, prices, purchase times, deadlines, tracking links, notes, photos, and return-to-index navigation. **Print / Save PDF** uses the browser's PDF output. Photo previews use temporary signed URLs; the embedded PDF photos remain in the document, and its Invsto order link provides durable access to stored evidence.

## Deployment and tests

Apply only `20261031170000_whatnot_workspace.sql` and `20261031171000_whatnot_api_connection.sql`; deploy `whatnot-order-sync` with `verify_jwt=false` (the handler validates staff JWTs or an unexpired single-use worker lease). Set the encryption key once, before connecting the account. Do not replace it while encrypted credentials depend on it. Publish frontend files and the rebuilt extension package, then reload the installed extension once. The sync can run without the extension; video capture needs it.

Tests: `whatnot-api.test.mjs`, `whatnot-database.test.mjs`, `whatnot-browser.test.mjs`, `whatnot-receipt-extension.test.mjs`, plus the existing TikTok receipt/extension release regression tests. Tests use isolated fixtures and do not print labels, create marketplace shipments or close real orders.
