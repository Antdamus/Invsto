import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../../email-triage.api.js", import.meta.url), "utf8");
const draftEdge = readFileSync(new URL("../../supabase/functions/ebay-conversation-draft/index.ts", import.meta.url), "utf8");

test("send replies persist operator and timestamp audit metadata", () => {
  assert.match(draftEdge, /sent_by:\s*admin\.userId \|\| null/);
  assert.match(draftEdge, /sent_by_email:\s*admin\.email \|\| null/);
  assert.match(draftEdge, /sent_at:\s*nowIso/);
  assert.match(draftEdge, /created_by_email:\s*metadata\.sent_by_email/);
});

test("email triage fetches local outbound reply audit metadata", () => {
  assert.match(api, /raw_message_metadata, created_at_ebay, created_at/);
  assert.match(draftEdge, /message_media, raw_message_metadata, created_at/);
});

test("outbound seller replies render who replied and when", () => {
  assert.match(js, /function ebayMessageAuditMetadata\(message\)/);
  assert.match(js, /function ebayMessageWasSentFromEmailTriage\(message, conversation = null\)/);
  assert.match(js, /function ebayOutboundReplyAudit\(message, conversation = null\)/);
  assert.match(js, /function renderEbayOutboundReplyAudit\(message, conversation = null\)/);
  assert.match(js, /Replied by \$\{escapeHtml\(audit\.actor\)\} at \$\{escapeHtml\(sentLabel\)\}/);
  assert.match(js, /renderEbayOutboundReplyAudit\(message, conversation\)/);
});

test("direct eBay seller replies keep OG Seller while triage replies show employee audit", () => {
  assert.match(js, /return ebayMessageWasSentFromEmailTriage\(message, conversation\) \? "Email Triage" : "OG Seller"/);
  assert.match(js, /if \(!ebayMessageWasSentFromEmailTriage\(message, conversation\) && !sendAttemptAudit\) return null/);
  assert.match(js, /actor:\s*actor \|\| sendAttemptAudit\?\.actor \|\| "Email triage user"/);
  assert.doesNotMatch(js, /actor:\s*actor \|\| "OG \/ Seller"/);
});

test("reply audit remains after canonical message replaces the sent placeholder", () => {
  assert.match(js, /function mergeEbayReplyAuditMetadata\(message, fallback\)/);
  assert.match(js, /rows\[duplicateIndex\] = mergeEbayReplyAuditMetadata\(message, rows\[duplicateIndex\]\)/);
  assert.match(js, /function ebayConversationSendAttemptAudits\(conversationId, state = adminClassificationState\)/);
  assert.match(js, /function ebayMessageMatchesSendAttemptAudit\(message, audit\)/);
  assert.match(js, /function ebaySendAttemptAuditForMessage\(message, conversation\)/);
  assert.match(js, /Boolean\(ebaySendAttemptAuditForMessage\(message, conversation\)\)/);
  assert.match(js, /sendAttemptId:\s*metadata\.local_send_attempt_id \|\| message\.send_attempt_id \|\| sendAttemptAudit\?\.sendAttemptId \|\| null/);
});

test("optimistic sent replies include audit metadata before refresh", () => {
  assert.match(js, /const sentByEmail = payload\.sent_by_email \|\| sendAttempt\.created_by_email \|\| attemptMetadata\.sent_by_email/);
  assert.match(js, /raw_message_metadata:\s*\{/);
  assert.match(js, /local_send_attempt_id:\s*attemptId \|\| null/);
  assert.match(js, /sent_by_email:\s*sentByEmail \|\| null/);
  assert.match(js, /sent_at:\s*sentAt/);
});
