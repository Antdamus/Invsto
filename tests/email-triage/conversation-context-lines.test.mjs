import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const context = readFileSync(new URL("../../supabase/functions/_shared/ebay-conversation-context.ts", import.meta.url), "utf8");
const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");

test("conversation context loads every line for a matched order", () => {
  assert.match(context, /const CONTEXT_VERSION = "ebay-conversation-context-v2"/);
  assert.match(context, /function mergeRowsById\(\.\.\.groups: Array<Array<Record<string, any>>>\)/);
  assert.match(context, /const linkedLines = \(linkedLinesResult\.data \|\| \[\]\) as Array<Record<string, any>>;/);
  assert.match(context, /\.from\("ebay_order_lines"\)\s*\.select\("id, order_id, item_number, transaction_id, custom_label, item_title, quantity, sold_for, total_price, line_status, internal_item_id, sale_id"\)\s*\.in\("order_id", allOrderIds\)/);
  assert.match(context, /const lines = mergeRowsById\(linkedLines, orderLines\);/);
  assert.match(context, /matched_order_lines: lines\.map\(\(line\) => compactOrderLine\(line, orderById\.get\(String\(line\.order_id\)\) \|\| null\)\)/);
});

test("task target labels distinguish whole orders from specific lines", () => {
  assert.match(js, /"Whole closed order"/);
  assert.match(js, /"Whole pending order"/);
  assert.match(js, /badge: "Whole order"/);
  assert.match(js, /"Specific closed line"/);
  assert.match(js, /"Specific pending line"/);
  assert.match(js, /badge: "Line item"/);
});
