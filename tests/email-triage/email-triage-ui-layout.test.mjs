import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../email-triage.css", import.meta.url), "utf8");

test("default eBay triage sidebar is grouped into working queues", () => {
  assert.match(js, /EBAY_SIDEBAR_QUEUE_GROUPS/);
  assert.match(js, /label:\s*"Inbox",\s*keys:\s*\["all",\s*"members",\s*"ebay_notifications",\s*"unread"\]/);
  assert.match(js, /label:\s*"Work Queues",\s*keys:\s*\["needs_reply_today",\s*"pending_tasks",\s*"review_queue",\s*"unclassified"\]/);
  assert.match(js, /label:\s*"Risk Queues",\s*keys:\s*\["high_dollar_risk",\s*"refund_return_risk",\s*"negative_feedback_risk",\s*"vip_buyers"\]/);
  assert.match(js, /ebaySidebarQueueView/);
  assert.doesNotMatch(js, /label:\s*"Inbox",\s*keys:\s*\[[^\]]*"has_order"/);
});

test("filter drawer keeps secondary filters and full taxonomy available", () => {
  assert.match(js, /renderEbaySystemFilterButtons\("State", \["unread", "unclassified", "pending_tasks", "needs_reply_today", "review_queue"\]/);
  assert.match(js, /renderEbaySystemFilterButtons\("Secondary Filters", \["last_24_hours", "has_order", "has_return", "has_media", "needs_context_review", "high_value_buyers", "refund_risk"\]/);
  assert.match(js, /renderEbayFilterGroup\(EBAY_SOURCE_FILTER_GROUP, state, \{ nested: true \}\)/);
  assert.match(js, /Full Taxonomy/);
  assert.match(js, /ebay-filter-modal-active/);
});

test("degraded mode is a slim details banner instead of default counter cards", () => {
  assert.match(js, /<details class="ebay-degraded-banner">/);
  assert.match(js, /Search and counts may be incomplete/);
  assert.match(js, /ebay-degraded-detail-grid/);
  assert.match(css, /\.ebay-degraded-banner/);
  assert.doesNotMatch(js, /ebay-conversation-summary-warning/);
});

test("selected conversation uses triage-first header and summary", () => {
  assert.match(js, /renderEbayTriageSummaryCard/);
  assert.match(js, /Triage Summary/);
  assert.match(js, /Recommended next step/);
  assert.match(js, /Suggested owner/);
  assert.match(js, /renderEbayTopClassificationChips\(classification, 5\)/);
  assert.match(css, /\.ebay-triage-summary-card/);
});

test("unclassified conversations use compact classify now CTAs", () => {
  assert.match(js, /No triage summary yet\./);
  assert.match(js, /Classify now to add filterable labels/);
  assert.doesNotMatch(js, /Classify first/);
});

test("conversation list chooses AI summary or preview as the primary line", () => {
  assert.match(js, /const primaryPreview = compactConversationText\(previewLines\.summary\) \|\| compactConversationText\(previewLines\.preview\)/);
  assert.match(js, /const primaryPreviewLabel = compactConversationText\(previewLines\.summary\) \? previewLines\.summaryLabel : previewLines\.previewLabel/);
  assert.doesNotMatch(js, /No AI summary stored/);
});

test("business context defaults to a compact summary with diagnostics collapsed", () => {
  assert.match(js, /ebay-context-compact-summary/);
  assert.match(js, /<details class="ebay-context-diagnostics">/);
  assert.match(js, /Link Confidence/);
  assert.match(css, /\.ebay-context-compact-summary/);
  assert.match(css, /\.ebay-context-diagnostics/);
});
