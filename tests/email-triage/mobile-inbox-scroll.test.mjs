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
  assert.match(html, /email-triage\.js\?v=buyer-history-targets-20260823/);
});

test("mobile eBay workspace stays compact and touch-friendly on phones", () => {
  assert.match(html, /email-triage\.css\?v=buyer-history-targets-20260823/);
  assert.match(css, /\.ebay-mobile-workspace-switcher\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*!important;/);
  assert.match(css, /\.ebay-mobile-workspace-switcher\s*\{[\s\S]*?top:\s*calc\(64px \+ env\(safe-area-inset-top\)\);/);
  assert.match(css, /\.ebay-conversation-sync-result \.inbox-skipped-reasons\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(css, /\.ebay-detail-head,\s*\.ebay-context-head\s*\{[\s\S]*?position:\s*static;/);
  assert.match(css, /\.ebay-conversation-actions,\s*\.ebay-conversation-filter-strip\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
});

test("message timeline actions stay compact on mobile", () => {
  assert.match(js, /isActionLoading \? "Generating" : "AI Reply"/);
  assert.match(js, /<i data-lucide="clipboard-plus"><\/i>\s*Task/);
  assert.match(css, /\.ebay-message-actions \.secondary-btn\s*\{[\s\S]*?border-radius:\s*999px;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.ebay-message-actions \.secondary-btn\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.doesNotMatch(css, /@media \(max-width: 760px\)[\s\S]*?\.ebay-message-actions,[\s\S]*?flex-direction:\s*column;/);
});

test("mobile message detail panels use compact controls instead of stacked blocks", () => {
  assert.match(js, /facts\.ogOrderLabel = facts\.isPendingOrder \? "Pending" : "History"/);
  assert.match(js, /<i data-lucide="history"><\/i>History/);
  assert.match(js, /isLoading \? "Refreshing" : "Refresh"/);
  assert.match(js, /<i data-lucide="mail-check"><\/i>\s*Sync/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.ebay-detail-actions\s*\{[\s\S]*?flex-direction:\s*row;[\s\S]*?overflow-x:\s*auto;/);
  assert.match(css, /\.ebay-detail-actions \.secondary-btn,\s*\.ebay-detail-actions \.ebay-maintenance-actions > summary\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?border-radius:\s*999px;/);
  assert.match(css, /\.ebay-order-context-actions,\s*\.ebay-purchase-context-actions\s*\{[\s\S]*?flex-direction:\s*row;[\s\S]*?overflow-x:\s*auto;/);
  assert.match(css, /\.ebay-order-context-actions \.ebay-order-context-link,\s*\.ebay-purchase-context-actions \.ebay-order-context-link\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-height:\s*30px;/);
  assert.match(css, /\.ebay-triage-summary-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(css, /\.ebay-triage-summary-grid div:first-child\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(css, /\.ebay-chat-tag-copy small\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.ebay-chat-add-tag-open\s*\{[\s\S]*?width:\s*auto;[\s\S]*?min-height:\s*32px;/);
});

test("mobile task composer renders as a compact phone sheet", () => {
  assert.match(html, /email-triage-asset-version" content="buyer-history-targets-20260823"/);
  assert.match(js, /<h3 id="ebay-task-modal-title">Create task<\/h3>/);
  assert.match(js, /<legend>Target<\/legend>/);
  assert.match(js, /<span>Instructions<\/span>/);
  assert.match(js, /placeholder="What should the owner do\?"/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.ebay-task-modal\s*\{[\s\S]*?align-items:\s*end;[\s\S]*?height:\s*100dvh;/);
  assert.match(css, /\.ebay-task-modal-card\s*\{[\s\S]*?max-height:\s*100dvh;[\s\S]*?border-radius:\s*16px 16px 0 0;/);
  assert.match(css, /\.ebay-task-source-summary p\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(css, /\.ebay-task-target-card\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?padding:\s*8px;/);
  assert.match(css, /\.ebay-task-modal-card \.ebay-draft-field textarea\s*\{[\s\S]*?min-height:\s*96px;/);
  assert.match(css, /\.ebay-task-assignment-panel p\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.ebay-refund-amount-field:not\(\.is-active\)\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.ebay-task-modal-actions\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?grid-template-columns:\s*\.72fr 1fr;/);
});
