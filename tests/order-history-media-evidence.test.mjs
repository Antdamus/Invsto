import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../ebay-order-history.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../ebay-order-history.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../ebay-order-history.css", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../supabase/migrations/20260827090000_order_history_staff_media_evidence.sql", import.meta.url),
  "utf8",
);

test("order history add evidence modal supports media files and label tracking", () => {
  assert.match(html, /Add closed-order evidence/);
  assert.match(html, /accept="image\/\*,video\/\*,application\/pdf"/);
  assert.match(html, /id="history-extra-photo-tracking"/);
  assert.match(html, /id="history-extra-photo-provider"/);
  assert.match(html, /External label PDF/);
  assert.match(html, /External label screenshot/);
  assert.match(html, /Save Evidence/);
});

test("order history evidence uploader sends media and tracking through the new RPC", () => {
  assert.match(js, /HISTORY_EVIDENCE_DOCUMENT_EXTENSIONS = new Set\(\["pdf"\]\)/);
  assert.match(js, /mimeType === "application\/pdf"/);
  assert.match(js, /media_type: mediaType/);
  assert.match(js, /trackingNumber/);
  assert.match(js, /labelProvider/);
  assert.match(js, /add_ebay_order_history_media_evidence/);
  assert.match(js, /_tracking_number: trackingNumber \|\| null/);
  assert.match(js, /_label_provider: labelProvider \|\| null/);
  assert.match(css, /\.event-file-thumb/);
});

test("order history media evidence migration grants staff access and stores searchable tracking metadata", () => {
  assert.match(migration, /create or replace function public\.add_ebay_order_history_media_evidence/);
  assert.match(migration, /public\.can_manage_inventory\(\) or public\.can_access_post_order_issues\(\)/);
  assert.match(migration, /bucket_id = 'order-evidence-photos'/);
  assert.match(migration, /trackingNumbers/);
  assert.match(migration, /shippingBarcodeNumbers/);
  assert.match(migration, /lookupKeys/);
  assert.match(migration, /externalLabelEvidence/);
  assert.match(migration, /grant execute on function public\.add_ebay_order_history_media_evidence/);
});
