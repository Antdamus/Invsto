# Add Item intake

New items now default to deferred pricing: employees save facts/photos without cost or selling prices, and Otello receives them in the dedicated [Pricing queue](inventory-pricing.md). The owner is changeable per item; administrators can change the default. Set prices now retains the original immediate-pricing flow below.

When setting prices now, the internal break-even price defaults to **cost ÷ 0.70**, rounded to cents. The divisor is editable from 0.01 to 1.00. Directly editing the break-even price switches to manual mode so later cost changes cannot overwrite it; turning calculation back on restores the formula. Drafts preserve the divisor and manual/automatic choice. Older drafts with an entered floor retain it. Deferred items still save without prices, and only retail prices are exposed to clients or eBay.

Measurements, diamond/stone type and description details are always visible in Identify. Watch materials and modifications also stay visible. Review repeats measurements and stones, including a reminder when blank, and keeps the title/description editor expanded. Unknown facts are not forced or invented.

The normal path is **Identify → Photos → Pricing → Review**. Choosing “Assign location and quantity now” or “Prepare for eBay” adds those steps. Back, visited steps and Review's Edit buttons preserve entered values. Next validates the current step; saving validates the whole active route. Enter on earlier steps advances without saving.

Watch intake asks for brand and reference once. Optional collection name, component materials, modifications, department and condition remain available. Watch and coin modes suggest inventory categories and use direct prices; jewelry retains weight-based cost calculation. Minimum sale price is internal, retail is the only listing price. Old missing minimum prices remain allowed.

Automatic description drafting starts after usable facts/photos are entered and runs while the user continues. The single title/description editor is in Review. Trusted user edits are never replaced automatically; an explicit replacement button can accept a newer draft. Responses for changed inputs or saved/reset items are discarded. Changes to facts clear untouched old automatic copy; changing watch identity also clears reference provenance. Automatic drafting can be disabled; manual entry is always available.

## Photos and eBay

Successful background processing replaces the original in the selected save set, leaving other selected photos untouched. The original stays in the gallery and can be included again; failures keep the original selected. The background model warms when Photos opens (or a photo draft is restored), using the same settings as processing. In-session black/white changes reuse the transparent cutout, including from an already processed photo. Resolution/model quality is unchanged. A first load still depends on the device and network. `node --test tests/add-item-refinements.test.mjs` checks replacement, retry/cache reuse and pricing behavior.

Background processing uses WebGPU when the browser supplies an adapter (including supported iPhone Safari versions). If the adapter is unavailable, preparation fails, or acceleration fails during a photo, it uses CPU with the same `isnet_fp16` model and PNG output. A failed GPU path stays disabled for that page session to avoid repeating the delay for each photo. Preparation is shared across callers and subsequent photos. The existing 1600px processing limit is unchanged; this optimization does not shrink images further. Tests cover both browser paths and failures at preparation/inference. A real Edge check confirmed accelerated inference and CPU recovery; phone-width layout checks do not substitute for physical iPhone performance testing.

Take photo opens the phone camera; Choose photos supports multiple images. All successfully uploaded photos are included automatically. Each new gallery/camera batch appears first, and its first successful photo becomes the cover; earlier photos remain included until removed. Previews use the actual uploaded file locally, while drafts keep storage paths and regenerate signed URLs on reload. Phone thumbnails appear above the cover in a two-column grid without a nested scrollbar. Tap Your photos to collapse or expand the gallery while keeping the selected photo and editing tools available; choosing new photos reopens it. Previous/Next below the preview cycle through included photos in gallery order without expanding the gallery or closing the editing tools. The counter shows the current position, and switching also chooses that photo as the cover. Saving a crop replaces just that photo in the included set and keeps the others selected. Photo pickers wait for draft restoration to finish so a delayed response cannot overwrite a new upload. The selected cover is used for AI and saved first. Individual failures identify the file to retry while retaining successful uploads. Crop, background, recent photos and station capture are optional tools. Coins include front/back guidance.

The optional eBay step reuses watch/coin facts and checks current requirements. Coin category search suggests matches from the series name without selecting an uncertain category. Missing required specifics appear first; additional and prefilled specifics are collapsed. Review lists remaining requirements with Edit actions. Saving inventory does not itself publish an eBay listing. Existing publishing validation still blocks incomplete listings and uses retail only.

## Saving and repeating

Selected photo-copy failures block insertion and preserve the draft. Once the item is inserted, a photo, stock-log or other follow-up failure is reported as a saved item needing attention; retrying cannot insert that item again from the same form. Stock placement still requires explicit confirmation. No label/printer operation is in the save path.

After saving, users can print now, print later, add a different item or add a similar item. Save & add similar moves straight to Identify when save follow-ups succeed. It retains shared category, supplier, material and watch/coin identity, plus prices only when requested. Year, mint, condition, modifications, grade, certification, photos, copy and barcode are cleared. A fresh barcode is generated. The previous location is only a suggestion; pending quantity and signatures are cleared and must be confirmed anew.

Cloud drafts are serialized per page to prevent a completed item's delayed write from replacing the next draft. They restore the active step, facts, photo selection and manual-copy ownership. Stock confirmation and the print batch are intentionally session state.

Print last item and Print batch use saved item snapshots, even while a different item is being edited. Labels are generated from the saved barcode and QR destination, attached to the item, then queued to the named computer selected in the shared print destination picker. A batch selects its computer once; the existing local download helper remains an explicit option. See [remote print stations](remote-print-stations.md) for setup and retry behavior. Failed entries remain available to retry. Batch state lasts for the current page session; Stock's Print DYMO Label can generate deferred labels later.

Existing barcode lookup runs early and offers the existing Add Inventory quick-add flow. Save rechecks uniqueness and reports duplicate conflicts without silently replacing a scanned barcode.

## Phone layout and verification

Photo tools open **Photo studio**, with a persistent preview and save bar on phones and a two-column layout on desktop/landscape. Frame supports one-finger dragging, anchored two-finger pinch zoom (25–600%), Center, Fit whole photo, quarter-turns, fine straightening, flipping and black/white canvas fill. Touch capture ends safely on cancellation, lost capture, a hidden page or resize. Mouse dragging and keyboard arrows/+/- remain available. Undo/Redo records each gesture or slider adjustment as one edit.

Adjust offers restrained brightness, contrast, color richness, warmth and sharpening, all initially neutral. Compare original shows the original colors in the same crop; saving always uses the chosen edits. Reset adjustments keeps framing, and Reset framing keeps adjustments. Processing runs locally with a cached preview and animation-frame updates; moving a photo does not reprocess its color pixels. Pixel processing avoids relying on Canvas.filter support in iPhone Safari. Sharpening preserves transparency and uses three source rows to limit memory.

Export renders from the source photo into lossless PNG, not from the small preview. The square output follows the source's longest side, with the existing 1200px minimum and a 4096px maximum for phone memory. The existing server upload limit is 8 MB; oversized edits remain open with an explicit error rather than silently reducing quality. Successful saves replace only the edited photo in the selected set; the original remains available in the gallery. Failed uploads retain the original selection and editor for retry. Closing during loading cannot reopen a stale photo; saving disables conflicting actions and prevents duplicate submissions. Edits not yet saved are session-only.

`node --test tests/item-photo-editor.test.mjs tests/add-item-refinements.test.mjs` checks gesture anchoring/cancellation, undo, color and alpha preservation, sharpening, export coordinates/resolution, save retry, duplicate saves and loading races. Responsive checks and touch-input verification use the connected browser with mocked storage; physical iPhone performance still requires a device check.

Phone navigation follows the form, category menus expand above it, fields use at least 16px text, and controls use touch targets. Dialogs use the visual viewport when the keyboard reduces available height.

Run `npm run test:add-item`, `npm run test:inventory-prices`, and `npm run test:coin-ebay`. Tests load the real form and handlers with mocked inventory, storage, AI and printer services. WebKit checks use `INVSTO_ITEM_BROWSER=webkit node --test tests/add-item-wizard.test.mjs` (PowerShell: set `$env:INVSTO_ITEM_BROWSER='webkit'` first). The suite covers 320px/390px portrait and 844px landscape, keyboard-sized dialogs, photo tools, changed AI inputs, drafts, optional steps, repeat entry, barcode matching, post-insert failures and label retry/batching. Real iPhone camera and printer hardware require device testing.

## Deployment

The original intake refinement is frontend-only. Remote printing additionally requires the migration and deployment documented in [remote print stations](remote-print-stations.md). Publish `add-item.html`, `additem-layout.js`, `additem-wizard.js`, `additem-wizard.css`, `additem-assisted.js`, `additem-intake.js`, `additem.js`, `additem-dymolabel.js`, `coin-ebay.js`, `stock.html` and `stock.js`. Keep the asset cache versions aligned. Existing watch/coin schemas and edge functions are reused; no new database migration is required. JWT verification settings are unchanged.

Photo studio additionally deploys `item-photo-editor.js` and `item-photo-editor.css` with the matching `add-item.html` / `additem-assisted.js` cache versions. No database or extension update is needed.
## Watch identity and stone categories

Watch titles use the entered brand/name and full model reference; AI-recognized serial numbers are not used as titles. Labeled serial numbers are removed from manually entered titles as well. Entered aftermarket modifications produce an explicit **Aftermarket** title qualifier and disclosure in the saved description. Factory-reference research cannot override those modifications.

The stone chooser offers Earth-mined diamonds, Lab-grown diamonds, Diamonds (origin unspecified), VVS simulated diamonds, Simulated diamonds, Moissanite, Cubic zirconia and No stone, with a free-text option for other/mixed stones. Confirmed selections add matching inventory categories beside the main item category. VVS simulated diamonds remain explicitly simulated in generated copy. Stone origin is not inferred from photos or carried over to a new item; cloud drafts retain their entered details, while Add similar clears the stone selection for the next piece.

Regression checks: `node --test tests/inventory-item-facts.test.mjs tests/add-item-watch-copy.test.mjs`. The pure shared rules live in `inventory-item-facts.js` and are loaded by both the intake page and the copy-generation function.

Watch descriptions retain the written copy and add only missing material, modification and stone details. Saving, editing, CSV export and direct eBay publishing share this rule instead of appending another Watch details block. Identical paragraphs are collapsed; distinct worker notes are retained. Existing inventory is not bulk-rewritten.

Deploy `generate-inventory-copy` and `ebay-inventory-sync` along with the shared script and updated frontend assets. No database migration or extension update is required.

## Watch intake sections

Watch intake now groups identity, materials/modifications, diamonds/stones, and condition/fit into four numbered sections. Brand and full reference drive model lookup; the optional collection name improves identification. The serial is stored in `watch_details.serial`, restored in drafts, and available in the internal Stock editor. It is excluded from generated titles/descriptions and AI request metadata. Do not put private serials in photographs intended for customers.

The modification chooser offers movement-only original parts (using the entered brand), aftermarket bezel, dial, bracelet/strap or stone setting, plus free text. `modificationPreset` and `modificationNotes` retain the selection while `modifications` carries the combined disclosure for existing consumers. The public title keeps Aftermarket; the description retains the full scope without duplicating it on repeat saves. Movement-only copy receives no factory technical specifications beyond the model identity; it does not assume the exact caliber from the reference.

Look up model runs the existing sourced reference and description generation from Identify. Factory dimensions are shown with their source, saved with the reference lookup and summarized in Review. An absent/ambiguous reference leaves dimensions unconfirmed and does not block saving. Dimensions stay separate from an optional measured `braceletFit`; only measured fit populates `item_length` for watches. Jewelry length is never inherited by a watch. Serial, condition, fit and modifications are cleared by Add similar.
