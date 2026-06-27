import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../email-triage.html", import.meta.url), "utf8");

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
