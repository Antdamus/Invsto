# Invsto Live Capture (1.1.1)

This helper copies visible eBay Stream Manager auction and payment evidence into Invsto. It can also prepare a new auction form from an inventory item you explicitly queue. It never clicks Create listing or Start, bids, charges buyers, or cancels eBay orders.

## Dedicated computer setup

1. Download **Invsto Live Capture** from Live Sales → Capture setup and connection help. Extract the ZIP into a permanent folder.
2. In Microsoft Edge open **Extensions → Manage extensions**. Enable **Developer mode**, choose **Load unpacked**, then select the extracted folder containing `manifest.json`. Chrome supports the same steps.
3. Sign in to Invsto and open **Live Sales**. Choose the eBay Live workflow, select its seller/store, paste the event URL, and start the show. No starting auction number is required. Use a new session for each event.
4. Open the **capture receiver** link on that page in the same browser profile. Keep it signed in and open. It receives notifications for every linked, unfinished show, including saved drafts.
5. Open the event's Stream Manager in a separate visible browser window. Click **Start Invsto capture** in the bottom-left corner. The helper selects Activity → All and Sold, and scrolls those lists. Before the first sale, eBay disables Sold; the helper watches All listings until Sold becomes available. Use another window if you need to operate the broadcast.
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

## After the broadcast

The helper detects eBay's explicit **Event ended** control and moves Invsto into **Post-show review**. A frozen clock or zero viewers never ends a show. With an older helper or if capture is stopped, use **Stream ended? Start bag review** in Invsto.

The inventory session stays open. Finish every paid bag, scan missing items, and use **Reopen to check / add items** to correct a closed bag. Payment failures, waiting payments and unmatched notifications still require review. A bag already in packing must be checked in Pending Orders.

Compare the complete auction list against the final eBay orders, including any sales capture missed. When all recorded paid bags are closed and outstanding payment/notification issues are resolved, confirm the physical bag and payment checkboxes and choose **Close reviewed session**. Ending the broadcast never automatically closes bags, cancels orders or releases inventory.

## Totals and timing

Totals include only paid, closed bags. Above minimum = auction price − captured inventory minimum prices. Estimated profit also subtracts captured item costs and the admin's explicit fee/shipping estimates per auction. Unknown values stay missing; they are excluded from the displayed partial total. These are USD estimates, not final payouts, tax accounting or realized profit after returns.

eBay's activity clock has minute precision. Stream offsets are approximate and can be unavailable; they are not exact replay timestamps. Capture and phone refresh target a few seconds while connected, but browser rendering, long history sweeps and network delays can increase latency. Treat this first release as a supervised pilot and compare it with eBay during a real show.

## Updating

Replace the extracted folder's files with the new download, click Reload on the extension card, and reload both the receiver and Stream Manager. Saved outbox data remains in that extension's browser profile when reloading the same installation.

## Data access

The extension runs only on eBay host-event pages and Invsto Live Sales. It stores the capture outbox/health, receiver tab IDs, and the current listing preparation ID/status locally. Supabase authentication stays in the signed-in Invsto page. No browser cookies, passwords, payment card details, shipping addresses or private eBay API tokens are collected.

## Scan stock into an auction (1.1.2)

1. In Live Sales, open **Scan stock → add an auction**. Paste the destination eBay Stream Manager URL and click **Use this event**, or use the selected show's event. This works without an Invsto sales session and before, during, or after a show; eBay controls whether that event's form accepts the listing. The helper's **Open Invsto receiver** link selects its own event automatically.
2. Scan the inventory barcode/QR. Review the saved item and photos, enter the starting bid and duration, then **Send to show computer**. The starting bid is explicit; minimum prices and costs stay internal.
3. On Stream Manager, open **Invsto · Add a stock item** in the bottom-right corner and click **Prepare next item**.
4. In **Add listings → From template**, choose a template with the correct category, condition, item specifics, shipping, and return settings. If no appropriate template exists, create or correct it on eBay first; the Live form inherits those settings.
5. Click **Fill selected template** in the helper. It replaces the template title, description and photos, sets the bid and duration, and keeps the duplicate count at one. Review the actual form, then click eBay's **Create listing** yourself. This does not start the auction.
6. Invsto records the new item ID when it sees the exact title appear. If the Sold tab or a long list hides it, switch to All and find the new listing, or enter its numeric eBay item ID in the helper and click **Record created listing**. Do not create it again because confirmation is delayed.

This first release prepares one unit of a stock item per show. Duplicate scans reuse the same request. Existing online listings are not changed; verify their available quantity before offering another unit. Preparing does not reserve or deduct inventory. Continue the paid-bag scanning workflow after a sale.

Listing preparation does not start capture, create a sales session, reopen a completed show, or alter payment and bag-review status. Keep capture linked to the correct Invsto show when you want to record payments and prepare bags.

During preparation, capture keeps reading visible payment evidence but stops changing tabs and scrolling lists. Once the listing is recorded, normal capture sweeps resume. Keep Activity visible and check captured payments against eBay. If preparation fails before submitting, close the unfinished template, release it in the helper, and retry from the phone. Once ready/submitted, inspect eBay before retrying; there is no automatic resubmission.

## Working without moving lists (1.1.1)

Capture does not reload Stream Manager. Its automatic mode scrolls the virtualized Activity and Sold lists to find payment evidence that is not currently rendered. Opening the stock-item helper or an eBay dialog now suspends that movement, including before a request is claimed. Typing, clicking, or scrolling also suspends it for fifteen seconds; focused fields remain protected.

Choose **Keep page still** to hold the lists until you click **Resume automatic capture**. This mode still records visible evidence, but does not claim complete capture readiness. Keep another Stream Manager tab in automatic capture for uninterrupted bag scanning while you work. A working or stopped tab no longer replaces the fresh health of another automatic capture tab for the same show.

Both helper panels link directly to **Open Invsto receiver**. Keep that signed-in tab open; its title identifies it as the capture receiver. The worker now tries registered receivers even when their background heartbeat timer is delayed. Reload the receiver after updating the extension.
