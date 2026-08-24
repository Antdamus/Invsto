import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const emailTriageHtml = readFileSync(new URL("../email-triage.html", import.meta.url), "utf8");
const emailTriageJs = readFileSync(new URL("../email-triage.js", import.meta.url), "utf8");
const orderHistoryHtml = readFileSync(new URL("../ebay-order-history.html", import.meta.url), "utf8");
const orderHistoryJs = readFileSync(new URL("../ebay-order-history.js", import.meta.url), "utf8");
const orderHistoryCss = readFileSync(new URL("../ebay-order-history.css", import.meta.url), "utf8");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("triage order-history context links search and focus the linked order line", () => {
  const assetVersion = emailTriageHtml.match(/email-triage-asset-version" content="([^"]+)"/)?.[1];

  assert.ok(assetVersion);
  assert.match(emailTriageHtml, new RegExp(`email-triage\\.js\\?v=${escapeRegExp(assetVersion)}`));
  assert.match(emailTriageJs, /function buildOrderHistoryContextUrl\(facts = \{\}\)/);
  assert.match(emailTriageJs, /params\.set\("historySearch", searchValue\)/);
  assert.match(emailTriageJs, /params\.set\("focusOrder", orderNumber\)/);
  assert.match(emailTriageJs, /params\.set\("focusLineId", lineId\)/);
  assert.match(emailTriageJs, /params\.set\("focusItemNumber", itemNumber\)/);
  assert.match(emailTriageJs, /params\.set\("focusTransactionId", transactionId\)/);
  assert.match(emailTriageJs, /historyHref: buildOrderHistoryContextUrl\(\{ orderNumbers, buyer, lines, orders \}\)/);
});

test("order history accepts direct order and line focus launch params", () => {
  assert.match(orderHistoryHtml, /ebay-order-history\.css\?v=history-focus-20260823/);
  assert.match(orderHistoryHtml, /ebay-order-history\.js\?v=history-focus-20260823/);
  assert.match(orderHistoryJs, /function getInitialHistoryFocusFromParams\(params\)/);
  assert.match(orderHistoryJs, /params\.get\("orderNumber"\)/);
  assert.match(orderHistoryJs, /focus\?\.orderNumber/);
  assert.match(orderHistoryJs, /function historyFocusMatchesLine\(line = \{\}, focus = state\.targetHistoryFocus\)/);
  assert.match(orderHistoryJs, /state\.expandedHistoryGroupIds\.add\(groupKey\)/);
  assert.match(orderHistoryJs, /data-history-line-focus="\$\{lineFocused \? "true" : "false"\}"/);
  assert.match(orderHistoryJs, /document\.querySelector\('\[data-history-line-focus="true"\]'\)/);
  assert.match(orderHistoryCss, /\.history-order-card\.is-history-focus/);
  assert.match(orderHistoryCss, /\.history-line-row\.is-history-focus/);
});
