# TikTok order workflow

TikTok uses `pending-tiktok-orders.html` and the same page with `?view=history`. eBay continues using its existing pages, tables, RPCs, checkout and packaging. The only additions to eBay pages are links styled as marketplace tabs. There is no combined marketplace view.

The TikTok workspace reuses the eBay fulfillment styles and navigation shell, with expandable buyer cards, receipt links, shipping-label coverage, saved documents, preparation and notes. Shipping summaries and filters show overdue, today, tomorrow and missing dates. Date comparisons use calendar days in America/New_York (including daylight-saving changes); a date-only deadline becomes overdue the following day. Unknown deadlines never imply overdue status. A buyer's earliest verified deadline determines their group, and filters keep that buyer's orders together. Groups with any missing dates also appear under Date needed. Shipping dates on a buyer card opens the verification and editing flow. History excludes urgency indicators for completed orders.

## Export and import

1. In TikTok Manage orders, select Orders → To ship.
2. Export **All orders under current tab** as CSV, including Awaiting collection.
3. In extension v1.0.15+, expand **OG · TikTok orders**, choose **Send orders to OG**, and select the downloaded CSV. Alternatively upload it directly in the TikTok workspace.
4. Review the count, item preview and actual export time, then confirm.
5. Export again after label purchases, package combinations and status changes. An All-orders export can refresh existing records into history, but does not backfill previously unseen historical/unpaid orders.

The parser preserves long IDs as text and rejects malformed rows, invalid quantities, conflicting duplicate records, unknown statuses and non-TikTok reports. Imports are transactional, serialized, audited and idempotent by file hash. Older snapshots cannot replace newer data. Missing orders/items never imply dispatch, cancellation or deletion. Reimports preserve staff notes and stages. Changed quantities on packed orders require review; dispatched orders retain their dispatch stage and receive an audit warning.

This initial workspace represents the OG Jewelers US shop. The CSV does not identify its originating shop, so staff must select that shop's export. Multi-shop importing requires an explicit shop identity before supporting additional accounts.

## Preparation and history

The TikTok-only tables are `tiktok_orders`, `tiktok_order_lines`, `tiktok_order_imports`, `tiktok_order_events` and `tiktok_order_documents`. Inventory staff can read through RLS; writes use permission-checked RPCs. Optimistic revisions prevent lost staff edits. Status changes and imports are recorded with the authenticated actor and server time.

OG stages are Pending, Preparing, Waiting, Packed and Dispatched. Waiting requires a reason. Packing requires physical-content confirmation. Dispatch requires Packed, tracking on every saved line and explicit carrier-handoff confirmation. Marketplace cancellations, unpaid status and return flags block packing/dispatch. Canceled, shipped, completed or internally dispatched orders appear in TikTok history.

These stages track work only: they do not debit stock, create sales, change TikTok or invoke eBay checkout. Staff can record a verified ship-by date, since TikTok's CSV omits deadlines. The extension can include deadlines from visible order rows; it does not claim to have traversed every page. Product descriptions are often generic, so matching the physical piece and the full TikTok receipt remains necessary.

## PDFs and videos

Watch receipt opens the full receipt in TikTok, under the staff member's TikTok login. Videos and signed media URLs are not copied or retained.

Extension **v1.0.17+** adds **Capture item photo → OG** beside the open TikTok receipt. Pause on the item and click Capture. The button shows the order number and SKU ID. For a multi-item order, the extension remembers the SKU of the receipt clicked; it refuses to guess when that identity is missing. Each OG item also has an **Open item video receipt** link that targets its SKU.

Only the visible video rectangle is cropped and sent to the configured TikTok workspace. OG saves the JPEG to the exact `(order_number, sku_id)` line and opens that order with its receipt thumbnail. The private `tiktok-receipt-photos` bucket and `tiktok_order_receipt_photos` table are separate from eBay. Stills remain attached to stable line IDs through CSV refreshes and TikTok history. Saves are audited and idempotent by transfer ID. A missing match leaves a retry action; staff can import the order and retry within one hour. Successful saves clear the image from extension handoff storage. Raw videos, full-page screenshots, and signed TikTok media URLs are not retained.

Download an order packet for one order, one buyer or the filtered view (up to 250 orders). Packets are paginated 4×6 PDFs marked **ORDER PACKET - NOT POSTAGE**. Print order packet saves its PDF and uses the existing shipping-printer picker. Shipping labels are downloaded from TikTok and attached only after checking recipient/order coverage. Documents use private paths under `tiktok-orders/<user-id>/<sha256>.pdf` in the existing PDF storage bucket; associations and events exist only in TikTok tables. Printing does not change any order stage. Review the PDF before printing; historical attachments remain available even if TikTok replaces tracking later.

Export this view downloads a TikTok-only tracking CSV. It is not a TikTok source import format.

## Deployment and checks

Apply `20261018030000_tiktok_order_workspace.sql` and `20261018050000_tiktok_receipt_photos.sql`, without replaying unrelated eBay migrations. Publish the new app files and the rebuilt extension ZIP/release metadata together. No Edge Function or TikTok API credential is needed for CSV imports or receipt stills.

Tests: `node --test tests/tiktok-orders.test.mjs tests/tiktok-orders-browser.test.mjs tests/tiktok-receipt-database.test.mjs tests/tiktok-receipt-extension.test.mjs`. Also run the existing TikTok printing, extension-updates and eBay CSV import suites when releasing the extension. Browser tests use isolated mock sessions and do not queue physical jobs.
