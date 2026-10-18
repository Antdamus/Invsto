# OG eBay Order Link

This unpacked Chrome/Edge extension adds OG shortcuts to eBay pages that show bulk shipping label order numbers and single-order shipping label pages.

## Install

1. Open Chrome or Edge.
2. Go to `chrome://extensions` or `edge://extensions`.
3. Turn on Developer mode.
4. Click Load unpacked.
5. Select this folder: `tools/ebay-og-order-link-extension`.
6. Click the extension icon and set the full OG Pending Orders URL, for example:
   `https://antdamus.github.io/Invsto/pending-orders.html`

## Check and distribute updates

Open **Extension updates** near the top of OG Pending Orders on each computer, or follow the link in the extension popup. It compares the installed version in that browser with the published release and offers the latest ZIP. Checks run on page load, on request, and every five minutes while the page is visible.

Versions before 1.0.3 need one manual update before OG can detect their version. An undetected version is not proof that the extension is missing or current.

To update an existing installation, extract the ZIP files over the **same installed folder**, click **Reload** on its card in `edge://extensions` or `chrome://extensions`, and refresh eBay and OG tabs. Keep the folder path to preserve the extension's settings. Repeat on each computer/browser; unpacked extensions do not install these updates automatically.

For future releases, increment `manifest.json`'s version and run `python tools/build-ebay-order-link-package.py`. Commit and deploy the source, `downloads/OG-eBay-Order-Link.zip`, and the generated `downloads/og-ebay-order-link-release.json` together. The release metadata comes from the packaged manifest and ZIP hash.

Version 1.0.4 sends labels directly to a ready OG tab without reloading the queue. Older OG pages keep the existing reload fallback, and an unrelated open order still blocks automatic delivery. Version reporting and the updates link remain available; no additional permissions are required.

Version 1.0.5 reduces receipt-capture transfer data by sending the original PNG once, overlaps retry storage with finding OG, and avoids switching to the saved receipt's OG tab twice. The page uploads the original and smaller previews together and returns after the screenshot and audit entry are saved; display details refresh in the background.

Version 1.0.6 stops receipt screenshot retransmissions as soon as OG accepts the transfer, while retaining the extension's retry copy until OG confirms the original and audit entry are saved. The updated page finishes optional thumbnails afterward, retries interrupted preview work from saved metadata, and refreshes only the affected customer card. The save message includes elapsed capture time. Original PNG quality is unchanged.

## Use

Version 1.0.14 also captures TikTok's signed `easesafe` document URLs, which have
no `.pdf` filename. A temporary capture watches only PDF tabs opened by the TikTok
tab after **Print through OG**. It also handles a blank tab navigated to the PDF.
The probe and fallback share one transfer ID so only one OG window opens. Cancelled
and expired captures cannot forward later files; ordinary TikTok printing stays
unchanged. Reload the extension and refresh TikTok after updating.

Version 1.0.13 adds TikTok online printing. In TikTok Seller Center, select the
existing shipping label, open **Print documents**, choose **PDF** and **4x6 inches**,
then click **Print → Print through OG**. Complete TikTok's own reprint confirmation
if it appears. OG Print stations opens with the existing shipping destination
picker: select your online 5XL, pages and copies, then explicitly send the labels.
Opening or cancelling the picker does not queue a job. **Use TikTok print** keeps
the original print flow. This is an option on TikTok's Print action, not a new OS
printer driver or a destination inside Edge's native print dialog.

The update uses the configured OG URL and its existing signed-in session. The PDF
is saved privately under `online-print/<user>/<content-hash>.pdf` in the existing
shipping-label bucket. It never attaches TikTok PDFs to eBay orders or changes order
fulfillment. Failed or cancelled sends can be retried; the existing print queue's
idempotency and printer selection checks still apply. A completed handoff cannot
automatically print twice. Extension recovery copies expire after one hour and are
removed on the next handoff/read; completed handoffs discard the extension's PDF.

If TikTok changes its export flow or the PDF cannot be captured, download its PDF,
open this extension's options and click **Choose PDF for online printer**. Choose
the file on OG Print stations and use the same printer picker. A6 and Letter/A4
documents need re-export as 4x6 for remote shipping printing. Native browser
printing remains available for other sizes.

Update the existing unpacked extension folder, reload its card in Edge/Chrome, and
refresh TikTok and OG Print stations. No new permissions, website deployment,
database migration or printer-helper update is needed for an existing PDF-ready
5XL station. The handoff panel is supplied by this extension on the configured
Print stations page only.

Version 1.0.12 recovers when the background video-receipt lookup fails even though the eBay order opens normally. It opens a fresh order tab, waits for the page, and follows only a receipt matching the requested eBay item number. Existing shipping drafts remain untouched. Background requests have a short timeout; sign-in or missing-receipt failures leave the order open with instructions. No new permissions are required. Update OG eBay Order Link on the affected computer, reload the extension, and refresh Invsto and eBay.

Version 1.0.11 requires **one shipping label per buyer** on eBay's single and bulk label creation pages. Keep the updated Invsto Pending Orders page open and loaded. The extension verifies all eligible pending orders for the buyer, offers **Load all orders** if any are missing, and replaces purchase controls with **Combine orders per buyer** while shipments remain separate. It guards Review purchase, Buy shipping label, Confirm and pay, and form submission. Undoing a combination blocks purchase again. If Invsto cannot verify the orders, creation stays blocked with a retry explanation. Combining does not purchase a label: review the total weight, dimensions, shipping address and service before buying. Existing label download, export and printing are unchanged. No new permissions are required. Refresh Invsto, reload the updated extension, and refresh eBay tabs on every shipping computer.

Version 1.0.10 replaces the metadata-only export on a canceled order with **Export cancellation + screenshot to OG**. It works on both the canceled Order details page and cancellation details, including eBay links using `itemId` + `transId` instead of `cancelId`. It attaches the original screenshot to the exact order's cancellation form without resetting notes or previous photos. Review and sign in Invsto to save it permanently. Multi-order cancellation lists retain their separate status-import action; a normal order's “Cancel order” menu does not qualify as cancellation evidence. No new permissions are required.

Version 1.0.9 keeps Invsto in front after cancellation/refund closeout while refreshing an existing eBay queue in the background. Cancellation screenshots go to the matching Invsto order without resetting other forms. Captures reject a changed/hidden source tab, preserve the original PNG, and keep a browser recovery copy until the signed cancellation saves successfully. Reopening that order's cancellation form restores unfinished screenshot drafts. Multiple captures preserve earlier photos and the operator's note. “Proof ready” means staged in the form; **Sign and Mark Canceled** permanently stores the selected screenshots with the signed Order History audit. Update the website and extension together, reload the extension, and refresh both eBay and Invsto tabs.

Version 1.0.8 only offers and forwards order reports when the selected eBay URL filter is Awaiting shipment. Navigation text on All orders no longer qualifies. The website also rejects reports from other pages and files containing already-shipped rows before importing anything; database guards protect older clients too.

Version 1.0.7 keeps cancellation detection on order-management pages and excludes Live Stream Manager, where chat text can otherwise create a false cancellation banner.

On the eBay bulk label page, the extension looks for order links like:

```html
<a data-testid="unique-order-id-link-01-14666-88282">01-14666-88282</a>
```

It adds:

- `Open in OG` next to each order number.
- A floating `Open N in OG` button for all visible order numbers.

The OG app opens with either:

```text
pending-orders.html?source=ebay&orderId=01-14666-88282
```

or:

```text
pending-orders.html?source=ebay&orderIds=01-14666-88282,01-12345-67890
```

The pending-orders page then loads the active user's normal session, narrows the queue to those eBay order numbers, and selects the first matching pending line.

On a single eBay label page such as:

```text
https://www.ebay.com/ship/single/24-14644-64854
```

it adds a floating `Open order in OG` button. That button sends the same `orderId` parameter plus a compact page snapshot with buyer, ship-to address, order value, shipping paid, selected shipping, expected delivery, selected label service, package dimensions, label total, product image, and packing slip URL.

## Send labels to OG

On eBay label-ready pages, the extension looks for:

```text
[data-testid="shipping-actions"] button[aria-label="Download label"]
```

It adds `Send Label to OG` next to eBay's download label action. When clicked, it:

1. Extracts the eBay order/shipment metadata from stable button attributes and surrounding tracking data.
2. Loads an extension-hosted page probe before clicking `Download label`, watching `fetch`, `XMLHttpRequest`, `URL.createObjectURL`, and PDF-ish anchor downloads.
3. Starts a browser-download fallback so Chrome/Edge download events can expose a direct label URL if eBay bypasses page fetch/blob APIs.
4. Captures the PDF blob before it becomes a browser PDF viewer or local file whenever possible.
5. Relays the PDF to an open OG Pending Orders tab, or opens the configured OG URL with a transfer id.
6. Lets the OG page upload the PDF with the signed-in user's Supabase session.

This avoids automating the browser print dialog and avoids assuming the extension can read a downloaded local file.

Required extension permissions now include:

- `storage` for the configured OG URL and pending label handoff.
- `tabs` so the background worker can find an already-open OG Pending Orders tab.
- `downloads` so the background worker can observe an eBay label download URL when the page does not expose the PDF through `fetch`, XHR, or blob hooks.
- `https://www.ebay.com/*` for eBay page injection.
- `https://*/*`, `http://localhost/*`, and `http://127.0.0.1/*` for the lightweight OG app bridge. The bridge only activates on the configured Pending Orders URL.

## Send awaiting-shipment report to OG

On eBay Seller Hub pages titled `Manage orders awaiting shipment`, the extension looks for the real visible `Download report` button, the `Results:` grid summary, and eBay's `orders-download-report` module signal. It adds a floating `Send Awaiting Orders Report to OG` button.

## eBay Live video receipt controls

On eBay Live replay receipt pages, the extension looks for eBay's replay video element:

```html
<video data-testid="replay-video">
```

It adds an `OG video controls` bar with play/pause, 5 second seek, 10 second seek, a scrubber, `Card` for nudging eBay's replay item card to refresh, `Winner` for copying the loaded winner username and opening that buyer in OG Pending Orders, and `Copy shot` for copying the visible replay page to the clipboard as a PNG. The screenshot hides the OG overlay before capture so the copied image shows the eBay replay page, including the auction card and username details visible on screen.

The `Keys` button opens the controller hotkey settings. Hotkeys are saved locally in the browser. Defaults:

- `Space`: play/pause
- `A`: rewind 5 seconds
- `D`: advance 5 seconds
- `J`: rewind 10 seconds
- `L`: advance 10 seconds
- `R`: refresh the visible eBay replay item card
- `W`: copy the visible winner username and open that buyer in OG
- `C`: copy visible replay screenshot to clipboard

When clicked, it:

1. Loads a report capture probe that watches report-ish `fetch`, XHR, object URL, and anchor downloads.
2. Starts a Chrome/Edge download fallback for the generated `eBay-OrdersReport` file.
3. Clicks eBay's native `Download report` button, not the bulk `Download selected` action.
4. Sends the captured report file plus source page metadata to OG Pending Orders.
5. Reuses the same Pending Orders CSV import pathway as the manual file picker.

The extension still does not read arbitrary local files from disk. It captures the generated report through page/network blob hooks or by refetching the browser-exposed download URL with the signed-in eBay session.

## Multi-item shipping box reminder

On eBay shipping-label pages, the extension watches for label workflows with 3 or more detected items/orders. When triggered, it shows an OG reminder to change the package dimensions before buying the label, with `4 x 4 x 4 in` shown only as an example size. If eBay's package dimension inputs are visible, the reminder includes a `Set 4 x 4 x 4` button that fills length, width, and height.


Version 1.0.1 rejects partial PDF captures and fetches a complete document when the
PDF viewer requests byte ranges. Existing incomplete attachments cannot be repaired
from missing bytes: use Replace Label in Invsto and Send Label to OG with the full
original eBay PDF. To update an unpacked install, replace its folder's files, click
Reload on the extension card, then refresh the eBay and Invsto tabs.

Version 1.0.2 also captures embedded PDF downloads (`data:application/pdf`) from
eBay's label-ready page, including links clicked before they are added to the
document. The complete PDF is captured before browser download metadata can
truncate its URL; the existing checks against incomplete PDFs still apply.
# TikTok orders and receipts (1.0.15)

TikTok uses its own `pending-tiktok-orders.html` workspace and history. No TikTok export is routed to the eBay importer.

In TikTok Orders, expand **OG · TikTok orders**. Open Export, choose **To ship → All orders under current tab → CSV**, and download the file. Click **Send orders to OG**, select the original CSV, review the preview and export time in OG, and confirm the import. Only visible order-list ship-by dates are included; missing dates remain unknown. The app also accepts the CSV directly.

The private handoff expires after one hour and its CSV is cleared after a successful import. Opening the destination never imports automatically. **Watch full receipt in TikTok** opens that order; this extension opens its video receipt automatically when the page has exactly one receipt. Multiple receipts stay available for staff to choose.

The existing TikTok Print → Print through OG flow is unchanged. Shipping PDFs can also be attached to a TikTok order and sent through the shared online-printer picker. OG order packets are separate 4×6 packing slips, not postage.
