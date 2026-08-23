import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const context = readFileSync(new URL("../../supabase/functions/_shared/ebay-conversation-context.ts", import.meta.url), "utf8");
const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");

test("conversation context loads every line for a matched order", () => {
  assert.match(context, /const CONTEXT_VERSION = "ebay-conversation-context-v6"/);
  assert.match(context, /function mergeRowsById\(\.\.\.groups: Array<Array<Record<string, any>>>\)/);
  assert.match(context, /function compactOrderGroup\(/);
  assert.match(context, /const linkedLines = \(linkedLinesResult\.data \|\| \[\]\) as Array<Record<string, any>>;/);
  assert.match(context, /\.from\("ebay_order_admin_events"\)\s*\.select\("id, action, order_ids, order_line_ids, created_at, payload"\)\s*\.overlaps\("order_line_ids", linkedLineIds\)/);
  assert.match(context, /const groupLines = \(groupLinesResult\.data \|\| \[\]\) as Array<Record<string, any>>;/);
  assert.match(context, /const contextSeedLines = mergeRowsById\(linkedLines, groupLines\);/);
  assert.match(context, /\.from\("ebay_order_lines"\)\s*\.select\("id, order_id, item_number, transaction_id, custom_label, item_title, quantity, sold_for, total_price, line_status, internal_item_id, sale_id"\)\s*\.in\("order_id", allOrderIds\)/);
  assert.match(context, /const lines = mergeRowsById\(contextSeedLines, orderLines\);/);
  assert.match(context, /const matchedOrderGroups = \(\(groupEventsResult\.data \|\| \[\]\) as Array<Record<string, any>>\)/);
  assert.match(context, /matched_order_lines: lines\.map\(\(line\) => compactOrderLine\(line, orderById\.get\(String\(line\.order_id\)\) \|\| null\)\)/);
  assert.match(context, /matched_order_groups: matchedOrderGroups/);
  assert.match(context, /order_total: numberOrNull\(row\.orderTotal\)/);
  assert.match(context, /function loadBuyerHistoryGroups\(/);
  assert.match(context, /\.overlaps\("order_line_ids", lineIds\)/);
  assert.match(context, /buyer_history_groups: buyerHistoryGroups/);
});

test("task target labels distinguish whole orders from specific lines", () => {
  assert.match(js, /"Entire closed order"/);
  assert.match(js, /"Entire pending order"/);
  assert.match(js, /all lines in this order/);
  assert.match(js, /order total/);
  assert.match(js, /badge: isRelatedHistorySet \? "Order set" : "Order"/);
  assert.match(js, /"This closed line only"/);
  assert.match(js, /"This pending line only"/);
  assert.match(js, /badge: "Line item"/);
});

test("task target picker stays limited to directly linked order targets", () => {
  assert.match(js, /"fulfilled", "successful", "success"/);
  assert.match(js, /function ebayConversationLinkedTargetIds\(context = \{\}\)/);
  assert.match(js, /function ebayConversationIdentifierSet\(values = \[\]\)/);
  assert.match(js, /function ebayConversationIdentifierMatches\(value, set = new Set\(\)\)/);
  assert.match(js, /function ebayConversationBuyerHistoryFallbackGroup\(context = \{\}, linkedTargetIds = \{\}, linkedLines = \[\]\)/);
  assert.match(js, /const orderNumbers = ebayConversationIdentifierSet\(safeArray\(linkedLines\)\.map\(\(line\) => line\?\.order_number \|\| line\?\.order\?\.order_number\)\)/);
  assert.match(js, /\|\| ebayConversationIdentifierMatches\(row\.item_number, itemNumbers\)/);
  assert.match(js, /\|\| ebayConversationIdentifierMatches\(row\.transaction_id, transactionIds\)/);
  assert.match(js, /const sameTitleRows = anchorTitle/);
  assert.match(js, /if \(sameTitleRows\.length <= 1\) return null;/);
  assert.match(js, /source: "buyer_history"/);
  assert.match(js, /function ebayConversationBuyerHistoryLinkedGroup\(context = \{\}, linkedTargetIds = \{\}, linkedLines = \[\]\)/);
  assert.match(js, /safeArray\(context\?\.buyer_history_groups\)\.find/);
  assert.match(js, /function ebayConversationGroupIsMultiTarget\(group = null\)/);
  assert.match(js, /function ebayConversationHasMultiEventHistoryGroup\(context = \{\}\)/);
  assert.match(js, /group\?\.source === "order_history_event" && ebayConversationGroupIsMultiTarget\(group\)/);
  assert.match(js, /function ebayConversationLinkedOrderGroup\(context = \{\}, linkedTargetIds = \{\}\)/);
  assert.match(js, /function chooseEbayConversationTaskOrderGroup\(context = \{\}, eventHistoryGroup = null, linkedOrderGroup = null, buyerHistoryFallbackGroup = null\)/);
  assert.match(js, /if \(eventHistoryGroup && ebayConversationGroupIsMultiTarget\(eventHistoryGroup\)\) return eventHistoryGroup;/);
  assert.match(js, /&& !ebayConversationHasMultiEventHistoryGroup\(context\)/);
  assert.match(js, /const linkedTargetIds = ebayConversationLinkedTargetIds\(context\)/);
  assert.match(js, /const directLines = linkedTargetIds\.lineIds\.length/);
  assert.match(js, /: linkedTargetIds\.orderIds\.length \? \[\] : allLines/);
  assert.match(js, /const linkedOrderGroup = chooseEbayConversationTaskOrderGroup\(/);
  assert.match(js, /const groupAmount = Number\(linkedOrderGroup\?\.total_price \|\| 0\)/);
  assert.match(js, /Entire related closed order set/);
  assert.match(js, /related closed lines/);
  assert.match(js, /taskScope: parentOrderIds\.length > 1 \? "group" : "order"/);
  assert.match(js, /orderLineIds: parentOrderIds\.length > 1 \? groupLineIds : \[\]/);
  assert.doesNotMatch(js, /const buyerHistoryLines = safeArray\(context\?\.buyer_value_line_breakdown\)/);
  assert.doesNotMatch(js, /"Order-history group"/);
});
