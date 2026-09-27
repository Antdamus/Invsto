# Add Item intake

The normal path is **Identify → Photos → Pricing → Review**. Choosing “Assign location and quantity now” or “Prepare for eBay” adds those steps. Back, visited steps and Review's Edit buttons preserve entered values. Next validates the current step; saving validates the whole active route. Enter on earlier steps advances without saving.

Watch intake asks for brand and reference once. Optional collection name, component materials, modifications, department and condition remain available. Watch and coin modes suggest inventory categories and use direct prices; jewelry retains weight-based cost calculation. Minimum sale price is internal, retail is the only listing price. Old missing minimum prices remain allowed.

Automatic description drafting starts after usable facts/photos are entered and runs while the user continues. The single title/description editor is in Review. Trusted user edits are never replaced automatically; an explicit replacement button can accept a newer draft. Responses for changed inputs or saved/reset items are discarded. Changes to facts clear untouched old automatic copy and reference provenance. Automatic drafting can be disabled; manual entry is always available.

## Photos and eBay

Take photo opens the phone camera; Choose photos supports multiple images. All successfully uploaded photos are included automatically. Each new gallery/camera batch appears first, and its first successful photo becomes the cover; earlier photos remain included until removed. Previews use the actual uploaded file locally, while drafts keep storage paths and regenerate signed URLs on reload. Phone thumbnails appear above the cover in a two-column grid without a nested scrollbar. Tap Your photos to collapse or expand the gallery while keeping the selected photo and editing tools available; choosing new photos reopens it. Previous/Next below the preview cycle through included photos in gallery order without expanding the gallery or closing the editing tools. The counter shows the current position, and switching also chooses that photo as the cover. Saving a crop replaces just that photo in the included set and keeps the others selected. Photo pickers wait for draft restoration to finish so a delayed response cannot overwrite a new upload. The selected cover is used for AI and saved first. Individual failures identify the file to retry while retaining successful uploads. Crop, background, recent photos and station capture are optional tools. Coins include front/back guidance.

The optional eBay step reuses watch/coin facts and checks current requirements. Coin category search suggests matches from the series name without selecting an uncertain category. Missing required specifics appear first; additional and prefilled specifics are collapsed. Review lists remaining requirements with Edit actions. Saving inventory does not itself publish an eBay listing. Existing publishing validation still blocks incomplete listings and uses retail only.

## Saving and repeating

Selected photo-copy failures block insertion and preserve the draft. Once the item is inserted, a photo, stock-log or other follow-up failure is reported as a saved item needing attention; retrying cannot insert that item again from the same form. Stock placement still requires explicit confirmation. No label/printer operation is in the save path.

After saving, users can print now, print later, add a different item or add a similar item. Save & add similar moves straight to Identify when save follow-ups succeed. It retains shared category, supplier, material and watch/coin identity, plus prices only when requested. Year, mint, condition, modifications, grade, certification, photos, copy and barcode are cleared. A fresh barcode is generated. The previous location is only a suggestion; pending quantity and signatures are cleared and must be confirmed anew.

Cloud drafts are serialized per page to prevent a completed item's delayed write from replacing the next draft. They restore the active step, facts, photo selection and manual-copy ownership. Stock confirmation and the print batch are intentionally session state.

Print last item and Print batch use saved item snapshots, even while a different item is being edited. Labels are generated from the saved barcode and QR destination, attached to the item, then queued to the named computer selected in the shared print destination picker. A batch selects its computer once; the existing local download helper remains an explicit option. See [remote print stations](remote-print-stations.md) for setup and retry behavior. Failed entries remain available to retry. Batch state lasts for the current page session; Stock's Print DYMO Label can generate deferred labels later.

Existing barcode lookup runs early and offers the existing Add Inventory quick-add flow. Save rechecks uniqueness and reports duplicate conflicts without silently replacing a scanned barcode.

## Phone layout and verification

Phone navigation follows the form, category menus expand above it, fields use at least 16px text, and controls use touch targets. Dialogs use the visual viewport when the keyboard reduces available height.

Run `npm run test:add-item`, `npm run test:inventory-prices`, and `npm run test:coin-ebay`. Tests load the real form and handlers with mocked inventory, storage, AI and printer services. WebKit checks use `INVSTO_ITEM_BROWSER=webkit node --test tests/add-item-wizard.test.mjs` (PowerShell: set `$env:INVSTO_ITEM_BROWSER='webkit'` first). The suite covers 320px/390px portrait and 844px landscape, keyboard-sized dialogs, photo tools, changed AI inputs, drafts, optional steps, repeat entry, barcode matching, post-insert failures and label retry/batching. Real iPhone camera and printer hardware require device testing.

## Deployment

The original intake refinement is frontend-only. Remote printing additionally requires the migration and deployment documented in [remote print stations](remote-print-stations.md). Publish `add-item.html`, `additem-layout.js`, `additem-wizard.js`, `additem-wizard.css`, `additem-assisted.js`, `additem-intake.js`, `additem.js`, `additem-dymolabel.js`, `coin-ebay.js`, `stock.html` and `stock.js`. Keep the asset cache versions aligned. Existing watch/coin schemas and edge functions are reused; no new database migration is required. JWT verification settings are unchanged.
