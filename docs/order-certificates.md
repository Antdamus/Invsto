# Watch certificates

Each persisted order line has a **CGL certificate** action in Pending Orders,
Packaging, and Order History. Scan its QR, paste the link, or add a PDF/photo.
Optional report and watch serial fields help identify the document. Staff must
verify the certificate belongs to that watch before saving.

CGL links automatically archive the document when the provider page exposes one
downloadable PDF. If the download is unavailable, upload a PDF or clear photo;
the link and copy are saved together. A link alone cannot be marked saved.
Up to six PDF/JPEG/PNG/WebP files of 10 MB each are supported per record.

Certificates use the stable `ebay_order_lines.id`, so they remain accessible
after completion and packaging without copying or changing order status,
inventory, reservations, tasks, or payments. History entries available only
from the eBay API have no persistent local line and do not expose this action.

## Storage and correction

`ebay_order_line_certificates` stores source link/QR, identifiers, attachments,
author and timestamp. Copies live in the existing private
`order-evidence-photos` bucket. Reads use existing staff capabilities; saves
validate the uploaded object's owner and line/request path. Signed download
links expire after ten minutes. Retry IDs and content hashes avoid duplicate
records/uploads after an uncertain response.

An author or admin can mark a wrong certificate incorrect with a reason. This
preserves the original record and copies for audit. Add the correct certificate
as a new record. Existing administrative bucket deletion privileges remain
unchanged; the certificate UI never deletes or overwrites originals.

## Deployment

1. Apply `20261009020000_order_line_certificates.sql`.
2. Deploy `archive-order-certificate` with both `index.ts` and
   `certificate-file.ts`. Gateway legacy JWT verification is disabled in
   `supabase/config.toml`; the function independently verifies the supplied
   user token and staff capability before any download or write. It uses the
   caller's authenticated client and existing storage policies.
3. Publish the shared JS/CSS and the three fulfillment/history page changes.

Automatic downloads allow only the three explicit CGL hosts, revalidate every
redirect, limit total time/size, and check file signatures. HTML is inspected
for one PDF link without running it. QR pages can generate a fresh PDF filename
on each request, so no resolved provider filename is hardcoded.

## Verification

`order-certificates-database.test.mjs` exercises permissions, attachment
ownership, retry handling, correction audit and persistence through fulfillment.
`order-certificates-files.test.mjs` tests PDF discovery, redirects, host and size
limits, and file signatures. `order-certificates-browser.test.mjs` covers mobile
and desktop layout, the shared QR scanner, copies/links, safe retries, failed
loads, and delayed file reads crossing item selections. Set
`INVSTO_ITEM_BROWSER=webkit` for the Safari-compatible test browser.

The user-provided CGL QR was decoded and its real PDF downloaded successfully
without attaching the example to an unconfirmed live order.
