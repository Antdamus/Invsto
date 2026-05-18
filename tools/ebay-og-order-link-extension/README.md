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
