# Client catalogue hosting

Client share links use `https://www.og-jewelers.com/private-catalogue#<share_token>`.
The token stays in the fragment; it is not sent to the static website host.
The client calls the curated `storefront-catalog?catalogue=<share_token>` endpoint,
which returns the explicitly selected client fields and chosen retail price only.

Cloudflare Pages project `invsto` serves `www.og-jewelers.com` from production
branch **initialaunch**, root **StoreWebsite**, build command `exit 0`, output `.`.
The **JoinPage** branch serves the staff Invsto app through GitHub Pages. Its
Cloudflare builds are previews, not the branded website's production deployment.

`node tools/build-client-catalogue.mjs` generates the client-only
`StoreWebsite/private-catalogue.html` shell. It references versioned public
catalogue CSS and JavaScript from Invsto's GitHub Pages deployment. No staff
authentication scripts or inventory management pages are included in that shell.

When changing the shell or its versioned asset URLs, deploy the assets to JoinPage,
then copy only the generated shell into an isolated checkout of initialaunch and
publish that change. Do not merge the full Invsto branch into the storefront.
Verify the branded page and its public API request before changing share links.

Staff previews intentionally remain on the same origin as the catalogue manager:
their postMessage exchange validates both opener and origin. Publishing a catalogue
is separate from previewing it. Existing GitHub catalogue links continue to work.


## Client requests and review

Clients submit from the curated catalogue. The endpoint accepts only chosen item
IDs, displayed retail prices, displayed credit, contact details and a note. The
service-only `submit_catalogue_request` RPC validates the current published
allowlist and amounts, locks the catalogue, and stores the authoritative snapshot.
A separate random receipt token is the idempotency key and private status secret;
the status URL places both tokens in the fragment. Catalogue holders cannot list
other requests or see other contacts. Receipt responses use an explicit allowlist.

`catalogue-requests.html` is the inventory-staff review queue. New submissions and
revisions send one in-app Catalogue notice to the catalogue creator; they do not
create tasks, SMS or email. Staff can approve, request changes, decline, cancel,
or record fulfillment. Every revision and decision has an immutable audit snapshot.

Approval allocates the catalogue allowance under a parent-row lock, so it cannot
be spent on two approved requests. Cancellation releases the allocation;
fulfillment retains it. Published catalogue credit shows the unallocated amount.
This is a catalogue allowance, not a bank payment or customer-account ledger.
The client's exact submitted prices are preserved for staff review.

Inventory is deliberately handled in the existing stock checkout, after staff
confirms availability and payment. The review screen links to Stock; staff then
records the completed checkout/sale reference to mark the request fulfilled.
This does not fabricate eBay orders or automatically deduct stock a second time.
The reference is staff-entered; no automated validation against the sales ledger
is performed by this release. Client-facing status updates appear on the private
status link and refresh while the page is visible; no external messages are sent.

Deploy migration `20261010220000_catalogue_requests.sql` and the updated
`storefront-catalog` Edge Function before publishing the frontend. Keep JWT
verification off for this existing public endpoint; service-only RPCs and staff
RLS protect the data. Do not expose the service-role key to the browser.
