# Invsto Live Capture (1.7.7)

## Printer receipt beside the buyer (1.7.7)

The minimized panel keeps the buyer's name visible beside a colored receipt for the displayed bag. **Green: Bag #… · Received by printer** appears only after the printer software acknowledges that bag's print job. **Amber** means queued, sending, or needing a printer check; **red** means failed or canceled. An unsent label or unavailable status stays neutral. Hover for the acknowledgement time, station and roll when available. The receipt does not prove the physical label emerged from the printer.

The badge follows the selected bag, including earlier bags, and updates automatically. Photo-saving feedback has its own line, so taking a screenshot does not hide the buyer or printer receipt. Reload the existing extension, then refresh Stream Manager and the signed-in receiver.

## Minimized screenshot button (1.7.6)

The minimized panel now has a gold **Screenshot / Bag #…** button beside Invsto. Check the displayed bag and click to save the live video frame without opening the full panel. It follows the same latest or manually selected bag as the full camera, regardless of payment state. Click **Invsto** to expand and choose a different bag; drag that side to move the panel.

The receipt shows **Saving**, then a green **Saved to bag #…** only after Invsto confirms the attachment. If another sale arrives, the button moves to the new bag while the last saved receipt retains its original bag number. An unconfirmed save shows **Retry photo** and stays on its original bag and image; retrying cannot create a duplicate attachment. A video-frame failure shows an error instead of success. The controls are disabled while a photo is being saved.

Reload the existing extension from its extension card, then refresh Stream Manager and the receiver. No new permissions or database update are needed.

## Sold-card layout recovery (1.7.5)

Capture reads both editable listing titles and the plain titles eBay displays on sold cards, with the listing image's accessible label as a fallback. Listing IDs, buyers, amounts and explicit payment badges remain required for matching; a win never proves payment.

Unreadable cards produce a visible warning with the count and missing fields, including when eBay shows Sold items but no readable cards. Other readable sales continue syncing. Layout diagnostics are collected during the live show as well as afterward. When listing details become readable, the existing Activity observations are resent with their original identities so missed sales can reconcile without duplicates. The receiver now reports the installed manifest version instead of a hard-coded version.

Reload the existing extension, then refresh Stream Manager and the receiver. Do not remove/reinstall the extension: keeping the installation preserves its capture queue and print-request identities.

## Photos and bag labels for every payment state (1.7.4)

Select any captured sold item with a recorded buyer to save a live photo or print its identification label. Paid, pending, failed, canceled and review-needed payments all stay available, including resolved bags. The panel and dropdown show the current payment state. Printing and taking photos do not mark an order paid, clear a hold, reserve stock, close a bag, or authorize shipment.

Automatic printing now queues newly observed sales with a buyer regardless of payment state. A later payment change does not produce another label. Existing retry/deduplication, Pause / Resume and finished-show behavior are preserved. Installing this update does not print the existing unpaid backlog; those items can be selected and printed manually. A superseded/merged record uses its current auction entry, and new bags still need an active show.

Replace the files in the installed extension folder, reload its extension card, and refresh Stream Manager and the signed-in Invsto receiver. Use the same installation to retain saved requests and capture history.

## Movable panel and mini button (1.7.3)

Drag the **Invsto** header to move the panel anywhere on Stream Manager. Click the **minus** in the upper-right corner to shrink it into a small **Invsto** button; click the button to reopen it. The small button is also draggable. Capture and automatic printing keep running while minimized, in-flight label/photo saves finish normally, and the selected bag stays selected. Requests needing a manual retry remain available when reopened.

The header shows capture status. The small button shows a status dot; hover for capture and printing details. Amber indicates waiting or attention needed, green indicates capture is ready, and gray indicates capture is off. The panel never opens itself over the seller's controls.

Position and minimized state are remembered in this browser across refreshes and shows. Both sizes stay inside the window when resized. Keyboard users can focus the header or small button and use arrow keys to move (Shift moves farther), or Home to reset. **Settings → Reset panel position** returns it to the bottom-left corner.

Replace the installed extension files, reload its extension card, then refresh Stream Manager and the signed-in receiver. Refresh reconnects to the same unfinished show. Keep both tabs open as usual.

## Current payment capture (1.7.2)

Current listing payment changes are resent even when a status appeared earlier. A current Paid card recovers an earlier failed payment. Cards without Paid remain excluded from paid totals and shipping clearance; they remain available for photos and bag labels. Visible listing payment snapshots refresh every 30 seconds while capture runs. The server ignores older snapshots.

## Receiver recovery (1.7.1)

A suspended receiver can no longer leave the shared capture queue waiting indefinitely: the extension worker stops waiting after eight seconds and keeps unacknowledged sales in its saved outbox for retry. Receiver heartbeats wait for the previous check to finish instead of accumulating behind it. Bag-label requests also have a worker deadline; uncertain manual sends retain their original request ID for safe retry.

This does not override Edge's sleeping-tab or background scheduling settings. Add `www.ebay.com` and `antdamus.github.io` to **Always keep these sites active**, keep the computer awake, and leave both the capture and receiver tabs open and signed in. Replace the installed extension files, reload its extension card, and refresh the capture tab and receiver to use this release. Refresh resumes the same unfinished show; do not start a new show.

This helper copies visible eBay Stream Manager auction and payment evidence into Invsto. Its compact bag-label panel shows the latest sold item, the bag number from its listing title, and the winner. It never bids, charges buyers, or cancels eBay orders.

## Bag labels from Stream Manager (1.7.0)

Keep the signed-in Invsto capture receiver open. **Print label** uses Live Sales' existing saved bag, 30299 label template and print system. Its QR identifies the unique bag, including the precise auction attempt; shipping can scan it to find the buyer and linked order lines. Printing does not close the bag, claim a scanner, or remove inventory. Payment state does not block identification-label printing or photos.

**Automatic printing:** new sales with a winner, regardless of payment state, go straight to the saved paired print station, without clicking Print. The panel checks every two seconds while the receiver is connected; the existing station helper then prints the queued label. **Pause / Resume** is visible on the panel. Selecting an earlier bag does not interrupt automatic printing. Opening a show for the first time, resuming after a pause, or reading finished-show history does not print earlier sales. Earlier bags remain in the dropdown for manual printing. Unknown older wins without a verified sale time also stay manual.

Automatic sends retain their queue identity across reloads and interrupted responses. The database reuses the same bag's existing print job across receiver tabs, staff and computers; failed or uncertain jobs require checking Print Stations before requesting another copy. A missing printer holds newly observed sales until one is chosen. Automatic mode needs a paired print station; the legacy local-file download option remains available for manual printing. Keep both Stream Manager and the signed-in receiver open.

Under **Settings**, choose the printer once using Invsto's existing print dialog. Later clicks reuse that computer and label roll. The previously selected Live Sales destination is used when its roll is already configured. This is the configured Invsto print destination, not automatic detection of the operating system's default printer. The local-helper option downloads the same label file for an already-running helper; a download alone does not confirm a physical print. Paired computers use the existing print queue, including when offline.

The panel follows the latest sold item automatically. The dropdown directly below the bag and Print button lists all captured bags with a buyer from this show by number and winner, newest first. Select a previous bag, check the displayed winner, and click **Print label**. A newer sale does not change your selection. Choose **Latest sold item · automatic** to resume following sales. **Reprint label** deliberately requests another copy. A lost acknowledgement retains the same request ID when retried, so the print queue does not duplicate it. The selected bag and every dropdown entry show the current queue status: Waiting for printer, Sending to printer, Sent to printer, or a problem that needs checking. Sent to printer means the printer software accepted the job; it is not proof that a physical label emerged. The receipt includes the acknowledgement time and destination/roll. These receipts include manual jobs, other staff computers, and older bags outside the latest 100 jobs. Active queued/sending labels cannot be sent again from the panel. If status cannot be read, the panel says Print status unavailable and keeps checking without sending extra copies. Capture start/stop, connection detail and movement controls are in Settings. The stock-listing helper is not loaded in this release, and the unrelated cancellation banner is hidden on Stream Manager.

## One-click live photos (1.7.0)

The small camera button beside Print saves a JPEG frame from the live video to the selected bag. The original video frame excludes chat, controls and dashboard content. Put the sold item in view, check the bag number/winner, then click the camera once. A saved message confirms the exact bag. The dropdown can select an earlier bag in any payment state. This does not print a label, add an inventory item, or close the bag.

Photos appear in Live Sales for the selected bag and bag history, and under Live photos when shipping scans its unique bag QR. Tap a thumbnail for the full image. Signed URLs use the existing private photos storage and staff access.

The image and bag are fixed at the click. If a save loses its confirmation, click the camera again to retry the same photo, even after a receiver or eBay reload. The same request cannot attach duplicate photos. An intentional later click takes a new photo. Pending photos stay in that tab's session storage until saved or discarded under Settings; closing that tab before a successful save can lose the pending capture.

This release adds a content script scoped to eBay's embedded media player at `ir.ebaystatic.com/cr/ebaylivepubweb/liveassets/shoplive/*/player.html`. It does not request desktop capture, camera access, or access to unrelated tabs. It reads a playing frame only after the camera button is clicked. Keep the live preview playing. Install/reload 1.7.0 and refresh eBay and the signed-in receiver to activate the new button.

## Dedicated computer setup

1. Download **Invsto Live Capture** from Live Sales → Capture setup and connection help. Extract the ZIP into a permanent folder.
2. In Microsoft Edge open **Extensions → Manage extensions**. Enable **Developer mode**, choose **Load unpacked**, then select the extracted folder containing `manifest.json`. Chrome supports the same steps.
3. Open the event's eBay Stream Manager dashboard, open **Settings** in the bottom-left bag-label panel, and click **Start Invsto capture**. The helper reads the saved date, timezone and title from Event information in a temporary background tab, then closes that tab. Your broadcasting tab stays on Stream Manager. It does not update the eBay event. Invsto opens automatically with that exact event and original date. Sign in if needed.
4. Choose the **First seller**, optionally check **Additional sellers**, and tap **Start show**. No store, URL, title or starting auction number is required. Invsto creates and links the session, then returns to the eBay capture tab. Repeating capture for the same unfinished event reconnects to its existing session and keeps its sellers. A completed show cannot be reopened by capture.
5. Keep the automatically opened **capture receiver** signed in and open. Observations are buffered while seller setup is pending and saved after the show is linked. The helper selects Activity → All and Sold, and scrolls those lists. Before the first sale, it watches All listings until Sold becomes available. Use another window if you need to operate the broadcast.
6. Keep the computer awake. Allow these two pages to stay active in the browser's sleeping-tabs / memory-saver settings. The receiver can be behind the Stream Manager window; the Stream Manager tab may remain in the background while its elapsed clock continues updating. If the clock stops, bring it forward. Refreshing the same eBay tab resumes its saved capture after Invsto confirms that show is still unfinished. Sellers stay unchanged. An explicit Stop stays stopped after refresh. Closing the tab or restarting the browser requires starting capture again. If the receiver was closed, the helper opens a replacement in the background; sign in there if needed.
7. On each phone, sign in to Invsto, open Live Sales, and select the same show. Wait for **Connected - auctions update automatically**, then choose **Scan sold item** on a paid auction. Scan the inventory barcode/QR, review the manifest, and **Close paid bag**. Printing is optional afterward and supports your existing print stations.

Start capture before the first auction when possible. A finished eBay event can backfill the Activity and Sold history that eBay still exposes. The original saved event date is the show start; the import time stays separate. Recovered history defaults to the first seller selected, because eBay does not identify your on-air employees. Admins can use Change seller on one sale, select several sales for a correction, or correct all earlier sales under Change seller. Each correction also updates its bag. Set the on-air seller during a running show for new auctions.

## Payment and recovery behavior

- After a finished history scan, the signed-in receiver automatically checks the current official eBay orders matching that event's captured listings. **Checking current eBay orders…** shows progress. Batches resume after a reload, retry after a connection error, and do not import inventory or change fulfillment. Keep the receiver open until the check finishes. Current same-order buyer aliases and timestamps resolve capture duplicates; final failed/cancelled/refunded orders remain held.
- A fresh official paid order can settle a historical failure recorded in the same minute as its single exact auction win. This requires the order's actual sale/payment timestamps and a later official check; a Paid card or stale imported header cannot settle that ambiguity. Failures in a later minute, unknown timestamps, conflicting wins, cancellations and staff holds remain for review.
- Failed Activity attempts with no auction win remain visible for payment review but stay outside eBay's Live sales total. A recorded win that was later cancelled or refunded stays in the historical auction total; it is not cleared for packing.
- Routine order sync refreshes current payment/cancellation evidence and retains prior usernames for that exact eBay order. A changed buyer name can combine a listing-only duplicate with its original Activity win only after complete history, matching totals, one exact order in the win's minute, and no staff work or conflicting attempt. Original evidence and the correction remain audited.
- Completed history combines a payment-only duplicate with its single auction win only when the event totals match, a unique official paid order falls in that win's minute, all failures precede payment, and no staff work or conflicting evidence exists. The original record and notifications remain audited. The receiver displays captured item sales alongside eBay Live sales.
- A finished event's Sold tab can include reused listings sold on a later day. Once both history passes finish, Invsto can exclude an untouched listing with no event Activity only when the dated auction wins exactly match eBay's Live sales total and its matched order belongs to a later day. The original capture and order link remain in audit evidence; the order is available to its actual show. New auction Activity reopens an exclusion for review.
- If an imported order header lacks payment status, an official paid order line must also have a matching Paid tile and a payment time after every historical failure before that failure can clear. Refunds, cancellations, later failures, and manual reviews remain held.
- Historical capture follows the actual scrolling viewport around eBay's virtualized lists. The Sold count must still match before history is considered read.
- Old-event Activity dates such as `Oct 2, 3:09 PM` retain their calendar date. Exact official-order comparisons use the item price before shipping and tax. After a show, an exact unique order with a recorded later payment can resolve earlier failed-payment notifications; the correction is audited. A Paid badge alone cannot resolve conflicting evidence.

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

Live Sales separates **Reading show history** from **Saving captured history**. It shows saved auction attempts, auction wins, paid attempts, payment issues, unmatched notifications, and how many eBay Sold listings have been read. Listings and auction attempts can differ because an item can be rerun. An empty sync queue alone never marks history complete. When history matches but payments still need attention, the receiver says **History read — payment review needed**. Matching totals do not clear failed, cancelled or refunded orders for packing.

For a finished event, the helper reads each settled viewport in both Activity and Sold twice and checks the Sold count. **Available history read** means the history currently exposed by those panels has been read; compare it against the final eBay orders. New evidence or a changed list restarts the relevant checks. Keep both pages active while reading. If reading pauses or the layout/count cannot be verified, resume capture or compare the complete history and document a **Manual history check** in the final checklist. That note does not import missing sales and cannot bypass pending data, unresolved payment issues, or unfinished bags. Closing the reviewed session disables automatic capture resume for that event.

The inventory session stays open. Finish every paid bag, scan missing items, and use **Reopen to check / add items** to correct a closed bag. Payment failures, waiting payments and unmatched notifications still require review. A bag already in packing must be checked in Pending Orders.

Compare the complete auction list against the final eBay orders, including any sales capture missed. When all recorded paid bags are closed and outstanding payment/notification issues are resolved, confirm the physical bag and payment checkboxes and choose **Close reviewed session**. Ending the broadcast never automatically closes bags, cancels orders or releases inventory.

## Totals and timing

Totals include only paid, closed bags. Above minimum = auction price − captured inventory minimum prices. Estimated profit also subtracts captured item costs and the admin's explicit fee/shipping estimates per auction. Unknown values stay missing; they are excluded from the displayed partial total. These are USD estimates, not final payouts, tax accounting or realized profit after returns.

eBay's Activity clock has minute precision. Invsto combines it with the event's saved date and the capture browser timezone, including overnight sales. It uses a single-day window from two hours before the scheduled start through 22 hours afterward; multi-day broadcasts cannot be uniquely dated from a clock alone. Ambiguous or nonexistent daylight-saving times remain unverified. Capture computers for one event must use the same timezone to avoid interpreting the same clock differently. Official order timestamps fill missing sale times when a unique order matches; order matching uses a date range, not an exact timestamp. The saved scheduled start is not proof of the exact second the broadcast began. Stream offsets are approximate and can be unavailable; they are not exact replay timestamps. Capture and phone refresh target a few seconds while connected, but browser rendering, long history sweeps and network delays can increase latency. Treat this first release as a supervised pilot and compare it with eBay during a real show.

## Updating

Replace the extracted folder's files with the new download, click Reload on the extension card, and reload both the receiver and Stream Manager. Saved outbox data remains in that extension's browser profile when reloading the same installation.

## Data access

The extension runs only on eBay host-event pages and Invsto Live Sales. It stores the capture outbox/health, receiver tab IDs, per-tab capture event/date metadata and resume state, and the current listing preparation ID/status locally. Supabase authentication stays in the signed-in Invsto page. No browser cookies, passwords, payment card details, shipping addresses or private eBay API tokens are collected.

Finished-show capture also reports bounded layout diagnostics every fifteen seconds: rendered item IDs, row counts, scroll-container sizes/positions and CSS classes, page visibility, whether a search is active, and recognized pagination controls. These help diagnose incomplete history scans. Diagnostics contain no page HTML, chat text or field values, do not move the page, and cannot change payment or sale records.

## Scan stock into an auction (1.1.3)

1. Open **Invsto · Add a stock item** on Stream Manager, then **Open Invsto receiver**. That link selects the event. In the same browser, Invsto can also detect the one open eBay event; with several open, choose one under **Change event**. On a phone, use the selected linked show, or set the destination once. The event is remembered on that device; pasting its URL is only a fallback under **Change event**.
2. In Live Sales → **Scan stock → add an auction**, set the starting bid and duration once for this event. With **Send each scan automatically** checked, scan the inventory barcode/QR and wait for **Sent** before the next scan. Event and auction settings survive a fresh visit and are stored per signed-in user and event on that device. Minimum prices and costs stay internal. Existing listing quantity checks or incomplete stock stop for review.
3. Keep the eBay stock helper open with **Prepare scans automatically** checked. It picks up each queued item and opens **Add listings → From template**. Choose a template with the correct category, condition, item specifics, shipping, and returns. The helper fills its title, description, stock photos, starting bid, and duration automatically, with one unit per listing. There are no separate Send, Prepare, or Fill clicks in this flow.
4. Review the form and click eBay's **Create listing**. This does not start the auction. After confirmation, the helper picks up the next item. If no appropriate template exists, create or correct one on eBay first. Automatic preparation pauses on a form error; use **Fill selected template** to retry after correcting it. Two helper tabs cannot prepare the same event simultaneously.
6. Invsto records the new item ID when it sees the exact title appear. If the Sold tab or a long list hides it, switch to All and find the new listing, or enter its numeric eBay item ID in the helper and click **Record created listing**. Do not create it again because confirmation is delayed.

This first release prepares one unit of a stock item per show. Duplicate scans reuse the same request. Existing online listings are not changed; verify their available quantity before offering another unit. Preparing does not reserve or deduct inventory. Continue the paid-bag scanning workflow after a sale.

Listing preparation works before, during, or after a show, without an active Invsto session. It does not start capture, create a sales session, reopen a completed show, or alter payment and bag-review status. eBay controls whether its event form accepts a listing. Keep capture linked to the correct Invsto show when you want to record payments and prepare bags.

During preparation, capture keeps reading visible payment evidence but stops changing tabs and scrolling lists. Once the listing is recorded, normal capture sweeps resume. Keep Activity visible and check captured payments against eBay. If preparation fails before submitting, close the unfinished template, release it in the helper, and retry from the phone. Once ready/submitted, inspect eBay before retrying; there is no automatic resubmission.

## Working without moving lists (1.1.1)

Capture does not reload Stream Manager. Its automatic mode scrolls the virtualized Activity and Sold lists to find payment evidence that is not currently rendered. Opening the stock-item helper or an eBay dialog now suspends that movement, including before a request is claimed. Typing, clicking, or scrolling also suspends it for fifteen seconds; focused fields remain protected.

Choose **Keep page still** to hold the lists until you click **Resume automatic capture**. This mode still records visible evidence, but does not claim complete capture readiness. Keep another Stream Manager tab in automatic capture for uninterrupted bag scanning while you work. A working or stopped tab no longer replaces the fresh health of another automatic capture tab for the same show.

Both helper panels link directly to **Open Invsto receiver**. Keep that signed-in tab open; its title identifies it as the capture receiver. The worker now tries registered receivers even when their background heartbeat timer is delayed. Reload the receiver after updating the extension.
# TikTok LIVE capture (1.8.1)

Open the TikTok Shop LIVE console at `shop.tiktok.com/streamer/live/product/dashboard`. In the Invsto panel, expand Settings and choose **Start TikTok capture**. The signed-in TikTok receiver opens; choose the seller once. TikTok Live is also linked from Invsto’s Live Sales page. TikTok records, payment evidence and show identity are separate from eBay; the existing bag-label printer, QR bag lookup and private photo storage are shared.

Capture reads **LIVE auctions → Sold items → Sort by latest**, including the exact username, display name, SKU/bag number, auction amount and displayed payment state. It scrolls the virtualized sold list twice, then watches the newest rows and repeats history checks. Typing, clicking or scrolling pauses movement for 15 seconds. **Keep page still** reads only visible records; use a second console tab for broadcast controls if needed. It never starts auctions, bids, changes prices, messages buyers, or changes payments. Buy-now purchases are not inferred from chat or aggregate GMV.

The durable outbox retains observations until Invsto confirms saving. Reloading the same capture tab resumes; explicit Stop stays stopped. A closed receiver is reopened in the background. Keep it signed in. Unknown layouts report an error; unfamiliar payment labels remain Needs review. Relative TikTok sale times are shown as approximate and do not become changing sale IDs. Fresh explicit Payment complete evidence can update a previously failed attempt without changing its bag. Captured payment status is evidence from the console, not a claim that refunds or shipping checks are complete.

New sales print one identification label automatically when a paired bag printer is configured. Existing history is available for manual printing without printing the entire backlog on connection. Automatic retries across receivers reuse the same server job. The colored receipt reports the actual printer-agent acknowledgement. A label or photo never authorizes shipment or deducts inventory. All payment states can retain photos and identification labels.

The Screenshot button saves only the live video frame to the exact selected bag, including from the minimized panel. Check that the item currently on camera matches that bag before clicking. Prior sales cannot receive an accurate historical screenshot from the current live frame. Failed saves retain the original frame and bag for an idempotent retry. Photos appear in the TikTok receiver and the shared bag QR lookup. The receiver provides buyer/payment filters, buyer index links, totals and a print/save report layout for desktop and phones.

Deploy `20261030020000_tiktok_live_capture.sql` and the new receiver assets before updating the extension. Reload Invsto Live Capture and the TikTok console to activate v1.8.1. Added content-script access is limited to the TikTok console and Invsto’s TikTok receiver. No new cookie, authentication, desktop-capture or broad browsing permissions are requested.
