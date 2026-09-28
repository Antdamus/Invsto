# Invsto Live Capture (1.0.1)

This helper copies visible eBay Stream Manager auction and payment evidence into Invsto. It does not start auctions, bid, change listings, charge buyers, or cancel eBay orders.

## Dedicated computer setup

1. Download **Invsto Live Capture** from Live Sales → Capture setup and connection help. Extract the ZIP into a permanent folder.
2. In Microsoft Edge open **Extensions → Manage extensions**. Enable **Developer mode**, choose **Load unpacked**, then select the extracted folder containing `manifest.json`. Chrome supports the same steps.
3. Sign in to Invsto and open **Live Sales**. Choose the eBay Live workflow, select its seller/store, paste the event URL, and start the show. No starting auction number is required. Use a new session for each event.
4. Open the **capture receiver** link on that page in the same browser profile. Keep it signed in, open, and on the matching show.
5. Open the event's Stream Manager in a separate visible browser window. Click **Start Invsto capture** in the bottom-left corner. The helper selects Activity → All and Sold, and scrolls those lists. Use another window if you need to operate the broadcast.
6. Keep the computer awake. Allow these two pages to stay active in the browser's sleeping-tabs / memory-saver settings. The receiver can be behind the Stream Manager window; the Stream Manager tab may remain in the background while its elapsed clock continues updating. If the clock stops, bring it forward. Click Start again after reloading it.
7. On each phone, sign in to Invsto, open Live Sales, and select the same show. Wait for **Connected - auctions update automatically**, then choose **Scan sold item** on a paid auction. Scan the inventory barcode/QR, review the manifest, and **Close paid bag**. Printing is optional afterward and supports your existing print stations.

Start capture before the first auction. A late start can backfill rendered auction cards, but seller attribution reflects the seller selected at capture time. Set the active seller when the on-air seller changes.

## Payment and recovery behavior

- **Won** means waiting for payment. Only explicit Paid evidence, an exact official order match, or an audited staff verification enables a scan.
- A failure, cancellation or refund stops new scans. Already scanned contents remain reserved until someone checks the physical bag. **Resolve locally and release bag contents** requires that check and a written reason. Cancel or refund the actual order separately in eBay when appropriate.
- A rerun is a new attempt. Replayed Paid badges cannot pay a later rerun. If two attempts cannot be distinguished, use Payment / bag review and verify the actual transaction in eBay.
- Unknown notifications pause automatic scanning. Review the notification, attach it to the affected auction if identifiable, and then verify that auction's payment or resolve it. Do not dismiss an unexplained payment failure.
- One scanner claims a bag at a time. An admin can release a stuck claim. Printing alone does not close a bag.
- If capture stops or becomes stale, scans pause. After verifying the current transaction directly on eBay, staff may record payment evidence for a two-minute manual scanning window.
- Unsent observations remain in the extension's local outbox until Invsto acknowledges a successful database save. Reconnect the receiver before ending the show. Do not uninstall the extension or clear browser storage while it reports pending observations.
- Existing eBay order imports reconcile exact unique matches and later cancellations/refunds, even after closing a bag. Packed items need the existing order/return correction workflow; the queue cannot silently put shipped stock back.

## Totals and timing

Totals include only paid, closed bags. Above minimum = auction price − captured inventory minimum prices. Estimated profit also subtracts captured item costs and the admin's explicit fee/shipping estimates per auction. Unknown values stay missing; they are excluded from the displayed partial total. These are USD estimates, not final payouts, tax accounting or realized profit after returns.

eBay's activity clock has minute precision. Stream offsets are approximate and can be unavailable; they are not exact replay timestamps. Capture and phone refresh target a few seconds while connected, but browser rendering, long history sweeps and network delays can increase latency. Treat this first release as a supervised pilot and compare it with eBay during a real show.

## Updating

Replace the extracted folder's files with the new download, click Reload on the extension card, and reload both the receiver and Stream Manager. Saved outbox data remains in that extension's browser profile when reloading the same installation.

## Data access

The extension runs only on eBay host-event pages and Invsto Live Sales. It stores only the capture outbox/health and receiver tab IDs locally. Supabase authentication stays in the signed-in Invsto page. No browser cookies, passwords, payment card details, shipping addresses or private eBay API tokens are collected.
