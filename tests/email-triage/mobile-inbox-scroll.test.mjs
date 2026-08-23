import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../email-triage.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../email-triage.css", import.meta.url), "utf8");

test("mobile inbox scroll position is remembered before opening a message", () => {
  assert.match(js, /let ebayMobileInboxScrollState = \{/);
  assert.match(js, /function rememberEbayMobileInboxScrollPosition\(row = null\)/);
  assert.match(js, /rememberEbayMobileInboxScrollPosition\(row\);\s*selectEbayConversation/);
  assert.match(js, /rowViewportTop: targetRow \? targetRow\.getBoundingClientRect\(\)\.top : 0/);
  assert.match(js, /listTop: list\?\.scrollTop \|\| 0/);
  assert.match(js, /panelTop: panel\?\.scrollTop \|\| 0/);
});

test("returning to mobile inbox restores the previous scroll anchor", () => {
  assert.match(js, /function restoreEbayMobileInboxScrollPosition\(\)/);
  assert.match(js, /normalized === "inbox" && options\.restoreInboxScroll !== false/);
  assert.match(js, /restoreEbayMobileInboxScrollPosition\(\)/);
  assert.match(js, /if \(list\) list\.scrollTop = Number\(saved\.listTop \|\| 0\)/);
  assert.match(js, /if \(panel\) panel\.scrollTop = Number\(saved\.panelTop \|\| 0\)/);
  assert.match(js, /window\.scrollTo\(\{ top: Math\.max\(0, targetTop\), behavior: "auto" \}\)/);
  assert.match(js, /row\.scrollIntoView\(\{ behavior: "auto", block: "center", inline: "nearest" \}\)/);
  assert.match(js, /window\.setTimeout\(restore, 80\)/);
});

test("mobile inbox switcher uses restore mode and ships with a fresh cache key", () => {
  assert.match(js, /restoreInboxScroll: button\.getAttribute\("data-ebay-mobile-view"\) === "inbox"/);
  assert.match(html, /email-triage\.js\?v=reply-audit-persist-20260627/);
});

test("mobile eBay workspace stays compact and touch-friendly on phones", () => {
  assert.match(html, /email-triage\.css\?v=mobile-polish-20260823/);
  assert.match(css, /\.ebay-mobile-workspace-switcher\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*!important;/);
  assert.match(css, /\.ebay-mobile-workspace-switcher\s*\{[\s\S]*?top:\s*calc\(64px \+ env\(safe-area-inset-top\)\);/);
  assert.match(css, /\.ebay-conversation-sync-result \.inbox-skipped-reasons\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(css, /\.ebay-detail-head,\s*\.ebay-context-head\s*\{[\s\S]*?position:\s*static;/);
  assert.match(css, /\.ebay-conversation-actions,\s*\.ebay-conversation-filter-strip\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
});
