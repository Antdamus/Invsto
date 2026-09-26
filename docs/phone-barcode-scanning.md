# Phone barcode scanning

Open Invsto in your phone browser and sign in normally. Camera scanning requires
HTTPS and browser camera permission; the GitHub Pages deployment provides HTTPS.

- **Add Item > Labels:** tap **Scan with camera** to use an existing barcode on a
  new item. Accepting the code updates the label preview and prepared DYMO label.
- **Add Inventory:** tap **Scan with camera** to look up an existing item and
  continue the normal stock confirmation flow. Each accepted scan counts once.
- **Stock:** use **Scan with camera** directly below the barcode search field;
  it fills that filter and keeps the other filters. The separate **Scan item**
  shortcut in the header clears other filters to search the whole current stock list.
- **Other barcode fields:** camera buttons appear beside item, tray, parent storage,
  container, auction/bag, and tracking fields across sales, orders, returns, transfers,
  locations, and activity searches. Buttons follow disabled/read-only field states.
  When a field requires an explicit Find action, accepting the code runs that lookup.
  Sales, transfers, and bag finalization retain their existing confirmation steps.

Aim at the entire barcode in good light. Check the result and tap **Use code**.
Use **Switch camera** if your browser exposes multiple cameras, or choose a sharp
barcode photo. The camera stops when a result is found, the scanner is closed,
photo capture starts, or the page is hidden. Processing stays on the device.

Supports ordinary 1D codes (including Code 128, UPC, EAN) and QR codes containing
an inventory identifier. Leading zeros are preserved. A website QR such as the
store website on a printed label is not an item identifier; scan the striped
barcode beside it. Scanning identifies a code, not product specifications or a
new product record from a manufacturer's catalog.

Validation: `npm run test:barcode` and `npm run test:add-item`. Tests use real
barcode images and a generated video stream, plus simulated camera permissions
and the existing inventory handlers. A physical phone camera is not covered by
these automated tests.

For new barcode inputs, add `data-camera-scan` to an input with a unique `id`.
The shared scanner adds its adjacent button, including for dynamic fields. Add
`data-camera-action="lookup-button-id"` only for a lookup that does not already run
on input; never point it at a submit/finalize action. Include the versioned shared
scanner CSS and JS on the page.

The camera reader uses the self-hosted ZXing-C++ WebAssembly decoder and scans
portrait/rotated codes as well as linear barcodes. If a visible code fails its
checksum, it shows a focus/glare hint and never uses the partial result. After
seven seconds without a readable result it shows recovery instructions while
continuing to scan. UPC-A retains the previous scanner's 12-digit representation;
zeros inside QR and Code 128 identifiers are preserved exactly.

To reproduce a private reported image locally without committing or uploading it,
set `INVSTO_SCANNER_REPRO_IMAGE` to its path and `INVSTO_SCANNER_REPRO_CODE` to the
known expected value before running the barcode tests. WebKit photo checks can
be run with `INVSTO_SCANNER_BROWSER=webkit`; Windows WebKit does not expose a
camera, so use the photo/field tests there and Chromium for the video-stream tests.
