# Remote DYMO print stations

Phones and computers can send Invsto labels to a specifically selected Windows computer over the internet. The remote computer runs a per-user helper and talks to its locally installed DYMO Connect web service. Each station selects exactly one installed LabelWriter; it never falls back to another printer. A computer that is asleep or offline keeps its jobs waiting.

## Setup and first physical test

1. Install DYMO Connect and verify the LabelWriter can print locally on the destination computer. Load the label stock used by Invsto's label template.
2. Sign in to Invsto as an administrator, open **Print Stations**, and name the computer (for example, Florida counter). Create its pairing code.
3. On that Windows computer, download `downloads/Invsto-Print-Station-Windows.zip`, extract every file, and run `Install-Print-Station.cmd`. Choose the printer and enter the code. Codes expire after 15 minutes; an unpaired station can get a replacement code.
4. The helper installs under `%LOCALAPPDATA%\InvstoPrintStation`, adds Start/Stop desktop shortcuts and starts at this user's Windows sign-in. It uses an installed Node >=20, or downloads and verifies the official Node 24 Windows runtime. No npm dependencies or administrator installation are needed for the helper itself.
5. Keep Windows signed in and awake, DYMO Connect available, and the printer connected. Confirm **Online · printer connected** on the station page.
6. On the phone, open an existing Stock item, choose **Print DYMO Label**, select that named computer, and request **one copy**. Check both the job status and the physical label. Confirm fit, barcode readability, and selected printer before larger batches.

The helper supports Invsto DYMO label XML, not arbitrary PDF or office documents. Internet access uses outbound HTTPS; there is no router setup or inbound remote-computer port.

## Print entry points

Add Item (last item, batch, and explicit draft-label printing), Add Inventory, Stock (including edited labels), bulk-bag capture/reprint, Locations, location drafts in intake, Live Sales, and Past Live Sales reprints use the same mobile destination picker. The remembered choice is still shown for explicit confirmation. A batch chooses its destination once. Copy count is 1–100 per label. **Download on this device (local helper)** remains an explicit option for the older Downloads-folder helper.

Automatic item-label preparation stays silent. Only an explicit print action opens the destination picker. Cancelling leaves prepared draft labels intact. Bulk-bag capture retains its barcode and label independently of later item-form changes, and its Print bag label action retries without capturing another bag. Past Live Sales records a reprint only after enqueue/download succeeds.

Location labels use the existing Address layout; item/bag labels use their existing jewelry layouts. Load the matching label stock. On a Twin Turbo, check which roll the first test label uses before printing a batch. Shipping-label PDFs in eBay Order History, and ordinary document printing, are separate from this DYMO XML queue.

The Print Stations page shows computers, connection status, queued and recent jobs. Inventory staff may enqueue/review jobs, cancel jobs still waiting, or deliberately request a new copy. Only active employee records with the admin role may pair/disconnect computers. Disconnecting revokes the station credential and cancels waiting jobs; a label already submitted cannot be recalled.

## Delivery and retry behavior

- An enqueue request has a persisted browser request ID. A lost response can be confirmed by retrying the same label, quantity and station, including after a page reload. A pending request cannot silently change stations. Merely viewing job history does not clear a pending enqueue ID.
- The server claims one job per station, with a lease. Other stations cannot read its XML, claim it, or acknowledge it. Offline printers do not claim waiting jobs.
- The helper persists a journal before every physical submission. It verifies the server claim and exact printer before sending each copy. It never resumes an interrupted journal by printing it again.
- Losing a final acknowledgment retries only the acknowledgment. Interrupted/expired/ambiguous submissions become **Check printer before retrying**. An explicit retry sends a new full-quantity request to the same station, with confirmation when a label may already have printed.
- **Sent to printer** means DYMO accepted the request. It does not prove paper completed. This is at-most-once automatic submission per claimed job, with conservative uncertainty after interruption, rather than a physical delivery guarantee.
- The helper's Stop shortcut finishes its current job. Start is protected by a process lock. Re-pairing is blocked until an outstanding journal has been acknowledged by the previous station.

## Security and storage

`20260927150000_remote_label_print_stations.sql` adds the station, pairing and job tables and RPCs. RLS and revoked client table grants prevent direct access. Staff RPCs use existing inventory permissions; station administration checks employee records rather than editable user metadata. Pairing codes are random, hashed and short lived. Each helper chooses a random 256-bit station credential, stored only as a hash by the server and protected with Windows DPAPI locally. Only that Windows account can decrypt it.

The ZIP contains only source files and the same public anon configuration used by the browser; it contains no privileged key, account password, or paired station credential. The helper receives XML only from its scoped queue, rejects non-label/oversized/entity-bearing documents and never executes label content. Application RPC authentication is separate from Edge Function gateway JWT settings; this feature adds no Edge Function and changes none of those settings.

Jobs and label XML are retained in the database in this initial release; recent-job UI displays the last 100 entries. No retention purge is scheduled.

## Troubleshooting

- **Not paired:** run the installer on the named computer and enter its current code.
- **Computer offline:** check internet, Windows sign-in/sleep and the Start Invsto Printer shortcut.
- **Printer disconnected:** open DYMO Connect and check the selected printer's USB connection, power and driver. Renaming/removing it does not redirect jobs to another printer.
- **DYMO Connect unavailable:** open DYMO Connect and enable its web service, then let the helper retry. Setup requires the local service to be running.
- **Uncertain:** inspect the physical printer before explicitly sending another request. Do not delete the journal to force a replay.
- Logs, pairing configuration and journal are in `%LOCALAPPDATA%\InvstoPrintStation`. Logs rotate at about 2 MB and contain status, not label XML or device tokens.
- To remove the helper, stop it, disconnect the station in Invsto, remove its Windows Startup shortcut and desktop shortcuts, then remove the per-user install directory after checking any outstanding job.

## Build and verification

`python tools/build-print-station-package.py` creates a deterministic ZIP from a six-file allowlist and verifies it contains the existing public anon key only. Commit the ZIP alongside its sources. Publish the frontend after applying the database migration.

`npm run test:print-stations` covers the worker's interrupted submissions, durable acknowledgments, wrong-printer protection, and the real destination UI with mocked services. Use `INVSTO_ITEM_BROWSER=webkit` for the phone browser engine. `npm run test:add-item` checks intake regressions. Tests do not print physical labels.

`npx supabase test db --linked supabase/tests/print_stations_test.sql` runs 27 transactional pgTAP checks and rolls back every test station and job. It needs the CLI's Docker test runtime and an existing active admin record in the linked project. The file covers access restrictions, pairing, idempotency, station isolation, offline queuing, claim expiry, acknowledgment recovery and revocation.

Verified for this release: 27 database checks passed through the authenticated CLI SQL runner with migrations disabled and all test data rolled back; the Docker pgTAP runner was unavailable on this host. The same pgTAP assertions were wrapped in one SQL block that raises on any failed assertion. No physical labels were printed during automated validation.

Coverage follow-up: 21 print-station/helper/browser checks and 44 Add Item regressions passed after routing the older label actions through the shared picker. The Windows helper and database did not change; an existing paired station needs no reinstall.
