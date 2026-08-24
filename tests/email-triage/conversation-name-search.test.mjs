import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const js = readFileSync(new URL("../../email-triage.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../../email-triage.api.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../email-triage.html", import.meta.url), "utf8");

test("conversation search indexes buyer identity and user names", () => {
  assert.match(js, /function ebayConversationIdentitySearchParts\(conversation\)/);
  assert.match(js, /identity\.username/);
  assert.match(js, /identity\.displayName/);
  assert.match(js, /identity\.name/);
  assert.match(js, /identity\.email/);
  assert.match(js, /summaryIdentity\.username/);
  assert.match(js, /conversation\?\.buyer_username/);
  assert.match(js, /ebayConversationIdentitySearchParts\(conversation\)/);

  assert.match(api, /const identity = conversation\.buyer_identity/);
  assert.match(api, /identity\.username/);
  assert.match(api, /identity\.display_name/);
  assert.match(api, /summaryIdentity\.username/);
  assert.match(api, /conversation\.buyer_username/);
});

test("typing in conversation search filters loaded rows immediately", () => {
  assert.match(js, /const preserveLoadedRows = searchChanged && safeArray\(adminClassificationState\.ebayConversations\)\.length > 0/);
  assert.match(js, /ebayConversations: nextConversations/);
  assert.match(js, /const nextVisibleRows = nextSelectionState \? filteredEbayConversations\(nextSelectionState\) : \[\]/);
  assert.match(js, /scheduleEbayConversationListReload\(context, \{ delay: searchChanged \? 180 : 0 \}\)/);
  assert.match(html, /email-triage-asset-version" content="task-mobile-sheet-20260824"/);
});
