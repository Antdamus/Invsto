import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../../email-triage.api.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../email-triage.html", import.meta.url), "utf8");
const draftEdge = readFileSync(new URL("../../supabase/functions/ebay-conversation-draft/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../supabase/migrations/20260823130000_ebay_user_read_state_and_response_status.sql", import.meta.url), "utf8");

test("personal eBay read state is backed by Supabase RPCs", () => {
  assert.match(migration, /create table if not exists public\.ebay_conversation_user_read_states/);
  assert.match(migration, /primary key \(user_id, conversation_id\)/);
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /create or replace function public\.upsert_ebay_conversation_user_read_state/);
  assert.match(migration, /create or replace function public\.list_ebay_conversation_user_read_states/);
  assert.match(api, /fetchEbayConversationUserReadStates/);
  assert.match(api, /saveEbayConversationUserReadState/);
  assert.match(js, /hydrateEbayConversationUserReadStates\(context, conversations\)/);
  assert.match(js, /persistEbayConversationUserReadState\(context, conversationId, readState\)/);
});

test("successful replies mark the conversation waiting on the buyer", () => {
  assert.match(migration, /mark_ebay_conversation_waiting_on_buyer_after_send/);
  assert.match(migration, /latest_message_not_outbound/);
  assert.match(migration, /'response_need', 'waiting_on_buyer'/);
  assert.match(migration, /latest_ebay_message_id = v_latest\.ebay_message_id/);
  assert.match(draftEdge, /markConversationWaitingOnBuyerAfterSend/);
  assert.match(draftEdge, /response_status_update/);
});

test("email triage cache busters include the read-state frontend update", () => {
  assert.match(html, /email-triage\.api\.js\?v=user-read-state-20260823/);
  assert.match(html, /email-triage\.js\?v=buyer-history-targets-20260823/);
});
