# OG eBay Order Link

This unpacked Chrome/Edge extension adds OG shortcuts to eBay pages that show bulk shipping label order numbers and single-order shipping label pages.

## Install

1. Open Chrome or Edge.
2. Go to `chrome://extensions` or `edge://extensions`.
3. Turn on Developer mode.
4. Click Load unpacked.
5. Select this folder: `tools/ebay-og-order-link-extension`.
6. Click the extension icon and set the full OG Pending Orders URL, for example:
   `https://your-site.com/pending-orders.html`

## Use

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

When clicked, it:

1. Loads a report capture probe that watches report-ish `fetch`, XHR, object URL, and anchor downloads.
2. Starts a Chrome/Edge download fallback for the generated `eBay-OrdersReport` file.
3. Clicks eBay's native `Download report` button, not the bulk `Download selected` action.
4. Sends the captured report file plus source page metadata to OG Pending Orders.
5. Reuses the same Pending Orders CSV import pathway as the manual file picker.

The extension still does not read arbitrary local files from disk. It captures the generated report through page/network blob hooks or by refetching the browser-exposed download URL with the signed-in eBay session.

## Multi-item shipping box reminder

On eBay shipping-label pages, the extension watches for label workflows with 3 or more detected items/orders. When triggered, it shows an OG reminder to change the package dimensions before buying the label, with `4 x 4 x 4 in` shown only as an example size. If eBay's package dimension inputs are visible, the reminder includes a `Set 4 x 4 x 4` button that fills length, width, and height.
