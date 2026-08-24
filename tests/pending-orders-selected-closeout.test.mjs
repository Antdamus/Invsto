import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../pending-orders.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../pending-orders.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../pending-orders.css", import.meta.url), "utf8");

test("pending order admin closeout is selected-only", () => {
  assert.doesNotMatch(html, /Close All Pending/);
  assert.doesNotMatch(html, /admin-close-all-pending/);
  assert.doesNotMatch(js, /all_pending/);
  assert.doesNotMatch(js, /getAllPendingAdminCloseoutLines\(\)\s*:/);
  assert.match(html, /id="admin-mark-cancelled"[^>]*>Close Selected<\/button>/);
  assert.match(js, /function getAdminCloseoutLinesForActiveScope\(\) \{\s*return getSelectedAdminLines\(\);\s*\}/);
  assert.match(js, /_order_line_ids:\s*lines\.map\(\(line\) => line\.id\)/);
});

test("pending order admin can select the currently visible queue before closeout", () => {
  assert.match(html, /id="admin-select-visible-pending"[^>]*>Select Visible<\/button>/);
  assert.match(js, /function setVisibleAdminOrderSelection\(checked = true\)/);
  assert.match(js, /state\.filteredOrders/);
  assert.match(js, /adminSelectedLineIds\.add\(line\.id\)/);
  assert.match(js, /admin-select-visible-pending"\)\?\.addEventListener\("click", \(\) => setVisibleAdminOrderSelection\(true\)\)/);
  assert.match(css, /#admin-select-visible-pending/);
  assert.match(html, /pending-orders\.js\?v=selected-closeout-20260824/);
  assert.match(js, /buyer-card-quick-select/);
  assert.match(js, /card\.querySelectorAll\("\[data-admin-group-select\]"\)/);
  assert.match(css, /\.buyer-card-quick-select/);
});
