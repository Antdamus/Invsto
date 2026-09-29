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

Location labels use the existing Address layout; item/bag labels use their existing jewelry layouts. Load the matching label stock. On a Twin Turbo, choose Left or Right in the print dialog and check the first physical label before printing a batch. Left and right are viewed from the front of the printer. Shipping-label PDFs in eBay Order History, and ordinary document printing, are separate from this DYMO XML queue.

The Print Stations page shows computers, connection status, queued and recent jobs. Inventory staff may enqueue/review jobs, cancel jobs still waiting, or deliberately request a new copy. Only active employee records with the admin role may pair/disconnect computers. Disconnecting revokes the station credential and cancels waiting jobs; a label already submitted cannot be recalled.

## Twin Turbo rolls and helper updates

The print dialog offers Left and Right for a paired Twin Turbo, identified by the installed printer model/name. Every copy uses the chosen roll via DYMO's `LabelWriterPrintParams/TwinTurboRoll`; automatic switching is never requested. Single-roll printers keep their normal printing behavior. The local-file download option does not set the remote roll.

Administrators can open **Roll settings** on Print Stations to name the stock on each side and set a default, or choose each time. For example, name Left "30299 jewelry tags" and Right "Address labels" only if that is what is physically loaded. These names are reminders, not automatic media sensing or label-size validation. The print dialog still allows an explicit override. Changing settings never changes a waiting job, and reprints retain the original roll. Job history shows the roll.

Install helper **1.1.1** on each printing computer for this feature: download the new ZIP, extract all files and run `Install-Print-Station.cmd` again. The installer waits for the old helper to finish, updates its files, preserves `station.json` and the protected pairing credential, and restarts it. An outstanding journal is recovered by acknowledgement only. No new pairing code is needed. Intentional re-pairing remains available by running `install-print-station.ps1 -PairAgain`; normal updates keep pairing.

The page enables roll selection after the updated helper checks in. The server never gives a roll-specific job to an older or unrecognized helper version; it waits for an update. Existing jobs created before roll support retain their old printer-default behavior. New Twin Turbo jobs need an explicit roll or saved station default. Already paired helpers are not remotely updated by publishing the website.

Protocol reference: [official DYMO Connect framework](https://github.com/dymosoftware/dymo-connect-framework/blob/master/dymo.connect.framework.full.js), `createLabelWriterPrintParamsXml` and `TwinTurboRoll`.

## Delivery and retry behavior

- An enqueue request has a persisted browser request ID. A lost response can be confirmed by retrying the same label, quantity, station and roll, including after a page reload. A pending request cannot silently change stations or rolls. Merely viewing job history does not clear a pending enqueue ID.
- The server claims one job per station, with a lease. Other stations cannot read its XML, claim it, or acknowledge it. Offline printers do not claim waiting jobs.
- The helper persists a journal before every physical submission. It verifies the server claim and exact printer before sending each copy. It never resumes an interrupted journal by printing it again.
- Losing a final acknowledgment retries only the acknowledgment. Interrupted/expired/ambiguous submissions become **Check printer before retrying**. An explicit retry sends a new full-quantity request to the same station and roll, with confirmation when a label may already have printed.
- **Sent to printer** means DYMO accepted the request. It does not prove paper completed. This is at-most-once automatic submission per claimed job, with conservative uncertainty after interruption, rather than a physical delivery guarantee.
- The helper's Stop shortcut finishes its current job. Start is protected by a process lock. Re-pairing is blocked until an outstanding journal has been acknowledged by the previous station.

## Security and storage

`20260927200000_print_station_roll_selection.sql` adds roll settings and per-job roll snapshots. `20260927150000_remote_label_print_stations.sql` adds the station, pairing and job tables and RPCs. RLS and revoked client table grants prevent direct access. Staff RPCs use existing inventory permissions; station administration checks employee records rather than editable user metadata. Pairing codes are random, hashed and short lived. Each helper chooses a random 256-bit station credential, stored only as a hash by the server and protected with Windows DPAPI locally. Only that Windows account can decrypt it.

The ZIP contains only source files and the same public anon configuration used by the browser; it contains no privileged key, account password, or paired station credential. The helper receives XML only from its scoped queue, rejects non-label/oversized/entity-bearing documents and never executes label content. Application RPC authentication is separate from Edge Function gateway JWT settings; this feature adds no Edge Function and changes none of those settings.

Jobs and label XML are retained in the database in this initial release; recent-job UI displays the last 100 entries. No retention purge is scheduled.

## Troubleshooting

Helper **1.1.1** searches the official DYMO loopback range 41951–41960 on 127.0.0.1 and localhost, using bounded parallel read-only probes. It prefers a service that reports the exact paired printer connected, then rechecks that service before every print. If the service moves or loses the printer, it rediscovers. A connected Copy 1 or differently named printer is never substituted. No changes to DYMO's single-port setting are needed for that supported range.

After updating, open **Diagnose Invsto Printer** on the desktop (or `Diagnose-Print-Station.cmd` in the extracted download). It lists each responding service, printer names and DYMO connection flags, including the saved paired name. It never decrypts credentials, polls/claims jobs, submits labels, or changes the journal. Share its output instead of `station.json`. Normal queued jobs can resume automatically when the helper finds its printer again.

Discovery reference: [DYMO framework service constants](https://github.com/dymosoftware/dymo-connect-framework/blob/master/dymo.connect.framework.full.js), `WS_START_PORT`, `WS_END_PORT`, `WS_SVC_HOST`, and `WS_SVC_HOST_LEGACY`.

- **Not paired:** run the installer on the named computer and enter its current code.
- **Computer offline:** check internet, Windows sign-in/sleep and the Start Invsto Printer shortcut.
- **Printer disconnected:** open DYMO Connect and check the selected printer's USB connection, power and driver. Renaming/removing it does not redirect jobs to another printer.
- **DYMO Connect unavailable:** open DYMO Connect and enable its web service, then let the helper retry. Setup requires the local service to be running.
- **Uncertain:** inspect the physical printer before explicitly sending another request. Do not delete the journal to force a replay.
- Logs, pairing configuration and journal are in `%LOCALAPPDATA%\InvstoPrintStation`. Logs rotate at about 2 MB and contain status, not label XML or device tokens.
- To remove the helper, stop it, disconnect the station in Invsto, remove its Windows Startup shortcut and desktop shortcuts, then remove the per-user install directory after checking any outstanding job.

## Build and verification

`python tools/build-print-station-package.py` creates a deterministic ZIP from a seven-file allowlist and verifies it contains the existing public anon key only. Commit the ZIP alongside its sources. Publish the frontend after applying the database migration.

`npm run test:print-stations` covers the worker's interrupted submissions, durable acknowledgments, wrong-printer protection, and the real destination UI with mocked services. Use `INVSTO_ITEM_BROWSER=webkit` for the phone browser engine. `npm run test:add-item` checks intake regressions. Tests do not print physical labels.

`npx supabase test db --linked supabase/tests/print_stations_test.sql` runs 27 transactional pgTAP checks and rolls back every test station and job. It needs the CLI's Docker test runtime and an existing active admin record in the linked project. The file covers access restrictions, pairing, idempotency, station isolation, offline queuing, claim expiry, acknowledgment recovery and revocation.

Verified for this release: 27 database checks passed through the authenticated CLI SQL runner with migrations disabled and all test data rolled back; the Docker pgTAP runner was unavailable on this host. The same pgTAP assertions were wrapped in one SQL block that raises on any failed assertion. No physical labels were printed during automated validation.

Coverage follow-up: 21 print-station/helper/browser checks and 44 Add Item regressions passed after routing the older label actions through the shared picker. The Windows helper and database did not change; an existing paired station needs no reinstall.

Roll release verification: 28 helper/browser checks, 4 WebKit roll-flow checks, and 51 transactional database assertions passed. The database preflight exercised the new migration and rolled it back along with all test data before deployment. The additional pgTAP suite is `supabase/tests/print_station_rolls_test.sql` (24 checks). Physical left/right printing still requires a test on the destination Twin Turbo.


## Helper 1.2.0: multiple printers and shipping PDFs

Run the normal installer to preserve existing pairings. Use `Add-Printer.cmd` and a
new Print stations pairing code for each additional printer on the same Windows
account. The original station stays in the root; additional profiles live under
`profiles/<uuid>`, with independent DPAPI credentials, locks and submission journals.
Startup and Start/Stop shortcuts cover every profile. A selected queue never falls
back to another printer.

Pending Orders and Order History (including extra labels) offer shipping printing
for saved private `ebay-labels` PDFs. The shared picker lists 5XL stations for PDFs
and keeps the inventory-label preference separate. Select pages explicitly for bulk
PDFs. Only approximately 4 x 6 inch pages are accepted; the browser normalizes selected
pages, and the worker checks dimensions, count and SHA256 again before submission.
Letter/A4 layouts need re-export from eBay. A request is capped at 10 MB/100 labels.

The restricted queue holds an immutable PDF snapshot. RPCs require inventory access;
the browser never receives station tokens or exposes signed PDF URLs to the helper.
Old helpers leave PDF jobs queued. PDF jobs use the same claim/lease, idempotency,
manual retry and no-automatic-replay protections as DYMO jobs. One submitted copy is
one full set of selected PDF pages; an interrupted set is uncertain, never replayed.

The installer verifies and installs the official SumatraPDF portable 3.6.1 engine
without changing default file associations. Its matching Windows queue (not the
DYMO web service) controls PDF readiness. The engine auto-detects page paper size;
`shrink,monochrome,simplex,1x` fits printable bounds and submits only one copy per
journaled operation. Physical printing and driver/media fit still need a test on
the destination computer. No shipping status or order fulfillment data is changed.
