import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../../email-triage.api.js", import.meta.url), "utf8");
const state = readFileSync(new URL("../../email-triage.state.js", import.meta.url), "utf8");
const draftEdge = readFileSync(new URL("../../supabase/functions/ebay-conversation-draft/index.ts", import.meta.url), "utf8");

test("email triage message bubbles expose translate-to-Spanish actions", () => {
  assert.match(js, /data-ebay-message-translate-action="to-spanish"/);
  assert.match(js, /translateEbayMessageToSpanish/);
  assert.match(js, /renderEbayMessageTranslation\(message, conversation\)/);
  assert.match(js, /Spanish translation from/);
  assert.match(js, /Already Spanish/);
});

test("translation state is local to eBay message ids", () => {
  assert.match(state, /ebayMessageTranslationsById:\s*\{\}/);
  assert.match(state, /ebayMessageTranslationLoadingId:\s*null/);
  assert.match(state, /ebayMessageTranslationErrorsById:\s*\{\}/);
  assert.match(js, /function ebayMessageTranslationKey\(conversationId, messageId\)/);
});

test("email triage API uses the existing eBay draft edge function for translation", () => {
  assert.match(api, /async function requestEbayMessageTranslation/);
  assert.match(api, /EBAY_CONVERSATION_DRAFT_FUNCTION/);
  assert.match(api, /mode: "translate_message"/);
  assert.match(api, /requestEbayMessageTranslation/);
});

test("translation mode preserves operational facts and returns structured JSON", () => {
  assert.match(draftEdge, /translate_message/);
  assert.match(draftEdge, /If the source text is English, translate it into natural Spanish/);
  assert.match(draftEdge, /If the source text is already Spanish, return it unchanged/);
  assert.match(draftEdge, /Preserve names, order numbers, item numbers, tracking numbers, money amounts, dates, and URLs exactly/);
  assert.match(draftEdge, /translated_text/);
  assert.match(draftEdge, /already_spanish/);
  assert.match(draftEdge, /stored: false/);
});
