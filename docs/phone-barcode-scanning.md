# Phone barcode scanning

Open Invsto in your phone browser and sign in normally. Camera scanning requires
HTTPS and browser camera permission; the GitHub Pages deployment provides HTTPS.

- **Add Item > Labels:** tap **Scan with camera** to use an existing barcode on a
  new item. Accepting the code updates the label preview and prepared DYMO label.
- **Add Inventory:** tap **Scan with camera** to look up an existing item and
  continue the normal stock confirmation flow. Each accepted scan counts once.
- **Stock:** tap **Scan item** to search by barcode. Accepting a scan clears the
  current search filters, including favorites, so they do not hide the item.
- **Placement:** tray, parent storage, and container fields also have camera buttons.

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
