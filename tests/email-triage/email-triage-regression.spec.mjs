import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  backfillCheckpoints,
  canonicalMailbox,
  classificationsForRun,
  conversationByEbayId,
  conversationMessages,
  createReadonlyClient,
  directUnclassifiedCount,
  envFlag,
  getAdminSessionFromPage,
  getSupabaseConfigFromPage,
  loadEmailTriageEnv,
  recentActivityEvents,
  recentClassificationRuns,
  recentSendAttempts,
  recentSyncRuns,
  readStateRows,
  redact,
  repoRoot,
  resolveHarnessPath,
  safeJsonParse,
  summarizeClassificationPayload,
  summarizeMessages,
  summarizeSyncPayload,
} from "./supabase-readonly-checks.mjs";

const env = loadEmailTriageEnv();
const storageStatePath = resolveHarnessPath(
  env.EMAIL_TRIAGE_STORAGE_STATE,
  "tests/email-triage/.auth/admin.json",
);
const reportDir = resolveHarnessPath(
  env.EMAIL_TRIAGE_REPORT_DIR,
  "tests/email-triage/reports",
);
const CLASSIFICATION_TERMINAL_STATUSES = ["succeeded", "partial_success", "failed"];
const CLASSIFICATION_TERMINAL_TITLES = {
  succeeded: "Classification Run Completed",
  partial_success: "Classification Run Partial Success",
  failed: "Classification Run Failed",
};
const RECLASSIFY_RECENT_RUN_MODE = "reclassify_recent_20";
const RECLASSIFY_RECENT_LIMIT = 20;

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value) {
  const numeric = numberOrNull(value);
  return numeric === null ? "--" : numeric.toLocaleString("en-US");
}

function summarizeConversationState(row = null) {
  if (!row) return null;
  return {
    id: row.id || null,
    ebay_conversation_id: row.ebay_conversation_id || null,
    conversation_type: row.conversation_type || null,
    other_party_username: row.other_party_username || null,
    latest_message_id: row.latest_message_id || null,
    latest_message_created_at: row.latest_message_created_at || null,
    latest_message_preview: row.latest_message_preview || null,
    message_count: numberOrNull(row.message_count),
    unread_count: numberOrNull(row.unread_count),
    provider_read_state: row.provider_read_state || null,
    local_read_state: row.local_read_state || null,
    pending_provider_update: row.pending_provider_update === true,
    last_provider_seen_at: row.last_provider_seen_at || null,
    last_local_read_at: row.last_local_read_at || null,
    last_read_sync_at: row.last_read_sync_at || null,
    read_sync_status: row.read_sync_status || null,
    read_sync_error: row.read_sync_error || null,
    last_detail_synced_at: row.last_detail_synced_at || null,
  };
}

function conversationStateAdvanced(before = null, after = null) {
  if (!before || !after) return false;
  const beforeCount = numberOrNull(before.message_count);
  const afterCount = numberOrNull(after.message_count);
  return (
    (after.latest_message_id || null) !== (before.latest_message_id || null) ||
    (after.latest_message_created_at || null) !== (before.latest_message_created_at || null) ||
    (after.latest_message_preview || null) !== (before.latest_message_preview || null) ||
    (beforeCount !== null && afterCount !== null && afterCount > beforeCount)
  );
}

function extractMetric(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`${escaped}:\\s*([0-9,]+|--)`, "i"));
  if (!match || match[1] === "--") return null;
  return Number(match[1].replace(/,/g, ""));
}

function chooseSearchTerm(conversation = {}) {
  const candidates = [
    conversation.other_party_username,
    conversation.ebay_conversation_id,
    conversation.reference_id,
    conversation.conversation_title,
  ];
  return candidates
    .map((value) => String(value || "").trim())
    .find((value) => value.length >= 3) || "";
}

const SMART_FOLDER_LABELS = {
  all: "All",
  members: "Members",
  ebay_notifications: "eBay Notifications",
  unread: "Unread",
  unclassified: "Unclassified",
  returns: "Returns",
  shipping: "Shipping",
  shipping_issues: "Shipping",
  needs_reply_today: "Reply today",
  vip_buyers: "VIP buyers",
  high_value_buyers: "High value",
  refund_risk: "Refund risk",
  review_queue: "Review queue",
  has_order: "Has order",
  has_return: "Has return",
  has_media: "Has media",
  needs_context_review: "Needs review",
};

function regexEscape(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function smartFolderButton(page, systemKey) {
  const label = SMART_FOLDER_LABELS[systemKey] || systemKey;
  return page
    .locator("#ebay-conversation-saved-views")
    .getByRole("button", { name: new RegExp(`^${regexEscape(label)}\\b`, "i") });
}

function customSmartFolderButton(page, name) {
  return page
    .locator("#ebay-conversation-saved-views")
    .getByRole("button", { name: new RegExp(`^${regexEscape(name)}\\b`, "i") });
}

const NATIVE_LABEL_FOLDER_EXPECTATIONS = {
  vip_buyers: { groupKey: "buyerFlags", value: "vip_buyer", label: "VIP Buyer" },
  high_value_buyers: { groupKey: "buyerFlags", value: "high_value_buyer", label: "High Value Buyer" },
  refund_risk: { groupKey: "riskFlags", value: "refund_risk", label: "Refund Risk" },
};

function folderCountTextToNumber(value) {
  const cleaned = String(value || "").replace(/[^0-9]/g, "");
  return cleaned ? Number(cleaned) : 0;
}

async function waitForMatchingTotal(page, expected) {
  await expect.poll(async () => {
    const text = await page.locator("#ebay-conversation-summary").innerText();
    return extractMetric(text, "Matching");
  }, { timeout: 30000 }).toBe(Number(expected));
}

async function expandClassificationFilters(page) {
  const panel = page.locator("#ebay-conversation-filter-panel");
  if (await panel.evaluate((node) => node.hidden).catch(() => true)) {
    await page.locator("#ebay-conversation-filter-toggle").click();
  }
  await expect(panel).toBeVisible();
}

function classificationFilterInput(page, groupKey, value) {
  return page.locator(`#ebay-conversation-filter-panel input[data-ebay-filter-group="${groupKey}"][value="${value}"]`);
}

function classificationFilterChip(page, groupKey, value) {
  return page.locator(`#ebay-conversation-filter-panel label.ebay-filter-chip:has(input[data-ebay-filter-group="${groupKey}"][value="${value}"])`);
}

async function setClassificationFilter(page, groupKey, value, active = true) {
  const input = classificationFilterInput(page, groupKey, value);
  if ((await input.isChecked()) !== active) {
    await classificationFilterChip(page, groupKey, value).click();
  }
  if (active) await expect(input).toBeChecked();
  else await expect(input).not.toBeChecked();
}

async function setSystemFilter(page, systemFilter) {
  const button = page.locator(`#ebay-conversation-filter-panel [data-ebay-system-filter="${systemFilter}"]`);
  await button.click();
  await expect(button).toHaveClass(/is-active/);
}

async function expectSystemFilterActive(page, systemFilter, active = true) {
  const button = page.locator(`#ebay-conversation-filter-panel [data-ebay-system-filter="${systemFilter}"]`);
  if (active) await expect(button).toHaveClass(/is-active/);
  else await expect(button).not.toHaveClass(/is-active/);
}

async function createSmartFolderThroughUi(page, { name, filters = [], systemFilter = null }) {
  await page.getByRole("button", { name: /^Create folder$/i }).click();
  const panel = page.locator("#ebay-conversation-filter-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("CREATE SMART FOLDER");
  const clearFilters = page.locator("#ebay-conversation-clear-filters");
  if (!(await clearFilters.isDisabled())) {
    await clearFilters.click();
    await expect(panel).toContainText("CREATE SMART FOLDER");
  }
  await panel.locator("[data-ebay-smart-folder-create-name]").fill(name);
  if (systemFilter) await setSystemFilter(page, systemFilter);
  for (const filter of filters) {
    await setClassificationFilter(page, filter.groupKey, filter.value, true);
  }
  await panel.locator("[data-ebay-smart-folder-create-save]").click();
  await expect(customSmartFolderButton(page, name)).toBeVisible({ timeout: 30000 });
  await expect(panel).not.toContainText("CREATE SMART FOLDER");
}

function chooseSmartFolderKey(counts = {}) {
  const preferred = [
    "unclassified",
    "returns",
    "members",
    "ebay_notifications",
    "shipping_issues",
    "needs_reply_today",
    "has_order",
    "has_media",
  ];
  return preferred.find((key) => Number(counts?.[key] || 0) > 0) || "all";
}

function stepReport() {
  const steps = [];
  return {
    steps,
    add(name, status, details = {}) {
      steps.push({
        name,
        status,
        details: redact(details),
        at: new Date().toISOString(),
      });
    },
  };
}

async function writeReport(report) {
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(reportDir, `email-triage-regression-${stamp}.md`);
  const lines = [
    "# Email Triage Live Regression Report",
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Base URL: ${report.baseURL}`,
    `- Service role used for read checks: ${report.usedServiceRole ? "yes" : "no"}`,
    `- Blocked send attempts: ${report.blockedSendAttempts.length}`,
    "",
    "## Steps",
    "",
  ];
  for (const step of report.steps) {
    lines.push(`### ${step.status.toUpperCase()} - ${step.name}`);
    lines.push("");
    lines.push(`- At: ${step.at}`);
    if (Object.keys(step.details || {}).length) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(step.details, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  if (report.blockedSendAttempts.length) {
    lines.push("## Blocked Send Attempts");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(redact(report.blockedSendAttempts), null, 2));
    lines.push("```");
    lines.push("");
  }
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

async function storageStateExists() {
  try {
    await fs.access(storageStatePath);
    return true;
  } catch {
    return false;
  }
}

async function adminSessionState(page) {
  try {
    return await page.evaluate(async () => {
      const client = window.supabase;
      if (!client?.auth?.getSession) return "supabase_not_ready";
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) return `session_error:${sessionError.message || "unknown"}`;
      const session = sessionData?.session;
      if (!session?.user?.id) return "no_session";

      const { data: employee, error: employeeError } = await client
        .from("employees")
        .select("role, active")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (employeeError) return `employee_error:${employeeError.message || "unknown"}`;
      if (!employee || employee.active === false) return "inactive_or_missing_employee";

      const role = String(employee.role || "").toLowerCase();
      return role === "admin" ? "admin" : `role:${role || "unknown"}`;
    });
  } catch (error) {
    const message = error?.message || String(error || "");
    if (/Execution context was destroyed|Cannot find context|navigation/i.test(message)) {
      return "navigation_in_progress";
    }
    throw error;
  }
}

async function waitForAdminSession(page) {
  await expect.poll(async () => adminSessionState(page), {
    timeout: 45000,
    intervals: [500, 1000, 2000],
    message: "Supabase Auth should hold an active admin session after login.",
  }).toBe("admin");
}

async function waitForMailboxReady(page) {
  await expect(page.locator("#ebay-conversation-status")).toContainText(
    /Loaded|DEGRADED MODE|eBay conversation load failed|Canonical eBay inbox is ready/i,
    { timeout: 60000 },
  );
  const status = await page.locator("#ebay-conversation-status").innerText();
  expect(status).not.toMatch(/load failed/i);
  await page.locator("#ebay-conversation-summary").waitFor({ state: "visible", timeout: 30000 });
}

async function ensureDashboardOpen(page) {
  const body = page.locator("#operational-dashboard-body");
  if (await body.evaluate((node) => node.hidden).catch(() => true)) {
    await page.locator("#toggle-operational-dashboard").click();
  }
  await expect(body).toBeVisible();
}

async function waitForFunctionResponse(page, functionName, predicate, action, timeout = 180000) {
  const responsePromise = page.waitForResponse((response) => {
    if (!response.url().includes(`/functions/v1/${functionName}`)) return false;
    const body = safeJsonParse(response.request().postData(), {});
    return predicate(body);
  }, { timeout });
  await action();
  const response = await responsePromise;
  const payload = await response.json().catch(() => ({}));
  return {
    status: response.status(),
    request: safeJsonParse(response.request().postData(), {}),
    response: payload,
  };
}

async function waitForFunctionResponseOrTimeout(page, functionName, predicate, action, timeout = 180000) {
  try {
    return await waitForFunctionResponse(page, functionName, predicate, action, timeout);
  } catch (error) {
    return {
      timedOutWaitingForBrowserResponse: true,
      error: error.message || String(error),
      request: null,
      response: null,
    };
  }
}

async function openEbayMaintenanceActions(page) {
  const menu = page.locator(".ebay-conversation-actions > .ebay-maintenance-actions").first();
  await expect(menu, "Advanced maintenance menu should be present for admin-only actions.").toBeVisible();
  const isOpen = await menu.evaluate((node) => node.open === true);
  if (!isOpen) {
    await menu.locator("> summary").click();
  }
  await expect.poll(async () => menu.evaluate((node) => node.open === true), {
    timeout: 5000,
    message: "Advanced maintenance menu should open before clicking maintenance actions.",
  }).toBe(true);
}

function assertSyncSafety(exchange) {
  if (exchange?.timedOutWaitingForBrowserResponse) return;
  expect(exchange.status).toBeLessThan(300);
  expect(exchange.response?.ok).not.toBe(false);
  expect(exchange.response?.safety?.ebayMutationsPerformed).toBe(false);
  expect(exchange.response?.safety?.sendsEnabled).toBe(false);
  expect(Number(exchange.response?.safety?.messagesSent || 0)).toBe(0);
}

function assertClassificationSafety(exchange) {
  if (exchange?.timedOutWaitingForBrowserResponse) return;
  expect(exchange.status).toBeLessThan(300);
  expect(exchange.response?.ok).not.toBe(false);
  expect(exchange.response?.safety?.ebayMutationsPerformed).toBe(false);
  expect(exchange.response?.safety?.sendsEnabled).toBe(false);
  expect(Number(exchange.response?.safety?.messagesSent || 0)).toBe(0);
}

function assertProviderReadSyncSafety(exchange) {
  if (exchange?.timedOutWaitingForBrowserResponse) return;
  expect(exchange.status).toBeLessThan(300);
  expect(exchange.response?.ok).not.toBe(false);
  expect(exchange.response?.safety?.ebayMutationsPerformed).toBe(true);
  expect(exchange.response?.safety?.sendsEnabled).toBe(false);
  expect(Number(exchange.response?.safety?.messagesSent || 0)).toBe(0);
}

function summarizeReadStateRows(rows = []) {
  const values = Array.isArray(rows) ? rows : [];
  return {
    sampled: values.length,
    providerUnread: values.filter((row) => row.provider_read_state === "unread").length,
    localUnread: values.filter((row) => row.local_read_state === "unread").length,
    legacyUnread: values.filter((row) => Number(row.unread_count || 0) > 0).length,
    pendingProviderUpdate: values.filter((row) => row.pending_provider_update === true).length,
    failedProviderUpdate: values.filter((row) => row.read_sync_status === "provider_update_failed").length,
    unknownProviderState: values.filter((row) => !["read", "unread"].includes(String(row.provider_read_state || ""))).length,
  };
}

async function assertSyncBannerMatches(page, exchange) {
  if (exchange?.timedOutWaitingForBrowserResponse) {
    await expect(page.locator("#ebay-conversation-sync-result")).toContainText(/timed out|durable run state recovered|finished/i, { timeout: 60000 });
    return;
  }
  const counters = exchange.response?.counters || {};
  const banner = page.locator("#ebay-conversation-sync-result");
  await expect(banner).toContainText(/finished|timed out|failed/i, { timeout: 60000 });
  const text = await banner.innerText();
  for (const [label, value] of [
    ["Conversations seen", counters.conversationsSeen],
    ["messages scanned", counters.messagesSeen],
    ["messages inserted", counters.messagesInserted],
  ]) {
    if (numberOrNull(value) !== null) {
      expect(text).toContain(formatNumber(value), `${label} should be reflected in the UI banner`);
    }
  }
}

function latestRun(rows = [], predicate = () => true) {
  return rows.find(predicate) || null;
}

function eventPayload(event = {}) {
  return event.metadata && typeof event.metadata === "object" ? event.metadata : {};
}

function eventRunId(event = {}) {
  const payload = eventPayload(event);
  return payload.run_id || payload.classification_run?.run_id || payload.classification_run?.id || null;
}

function syncExchangeFromDurableRun(run = {}, request = {}) {
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
  return {
    status: 200,
    request,
    response: {
      ok: true,
      reconciledFromDurableRun: true,
      runId: run.id || null,
      runType: run.run_type || request.runType || null,
      status: run.status || null,
      safety: {
        ebayMutationsPerformed: metadata.ebayMutationsPerformed === true,
        sendsEnabled: metadata.sendsEnabled === true,
        messagesSent: 0,
      },
      counters: {
        pagesFetched: Number(run.pages_fetched || 0),
        conversationsSeen: Number(run.conversations_seen || 0),
        conversationsInserted: Number(run.conversations_inserted || 0),
        conversationsUpdated: Number(run.conversations_updated || 0),
        messagesSeen: Number(run.messages_seen || 0),
        messagesInserted: Number(run.messages_inserted || 0),
        messagesUpdated: Number(run.messages_updated || 0),
        messagesRechecked: Number(metadata.messagesRechecked ?? metadata.messages_rechecked ?? 0),
        canonicalDetailSweepCandidates: Number(metadata.canonicalDetailSweepCandidates || 0),
        canonicalDetailSweepRefreshed: Number(metadata.canonicalDetailSweepRefreshed || 0),
        canonicalDetailSweepConversationIds: Array.isArray(metadata.canonicalDetailSweepConversationIds)
          ? metadata.canonicalDetailSweepConversationIds
          : [],
        canonicalDetailSweepMessagesInserted: Number(metadata.canonicalDetailSweepMessagesInserted || 0),
        canonicalDetailSweepMessagesUpdated: Number(metadata.canonicalDetailSweepMessagesUpdated || 0),
        canonicalDetailSweepMessagesRechecked: Number(metadata.canonicalDetailSweepMessagesRechecked || 0),
        conversationIds: Array.isArray(metadata.conversationIds) ? metadata.conversationIds : [],
      },
    },
  };
}

test("authenticate admin @setup", async ({ page }) => {
  const hasExistingState = await storageStateExists();
  const email = env.EMAIL_TRIAGE_ADMIN_EMAIL;
  const password = env.EMAIL_TRIAGE_ADMIN_PASSWORD;
  if (!email || !password) {
    if (hasExistingState) return;
    throw new Error("Set EMAIL_TRIAGE_ADMIN_EMAIL and EMAIL_TRIAGE_ADMIN_PASSWORD, or provide EMAIL_TRIAGE_STORAGE_STATE.");
  }

  await page.goto("/index.html?next=email-triage.html");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("#login-submit").click();
  await waitForAdminSession(page);
  await page.goto("/email-triage.html");
  await expect(page.locator("#ebay-conversation-status")).toBeVisible({ timeout: 30000 });
  await waitForMailboxReady(page);
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
  await page.context().storageState({ path: storageStatePath });
});

test("email triage authenticated regression harness", async ({ page }, testInfo) => {
  const report = stepReport();
  const fullReport = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    baseURL: testInfo.project.use.baseURL || env.EMAIL_TRIAGE_BASE_URL || "",
    usedServiceRole: false,
    blockedSendAttempts: [],
    steps: report.steps,
  };

  await page.route("**/functions/v1/ebay-conversation-draft", async (route) => {
    const request = route.request();
    const body = safeJsonParse(request.postData(), {});
    if (body?.mode === "send") {
      fullReport.blockedSendAttempts.push({
        url: request.url(),
        method: request.method(),
        body,
      });
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.route("**/commerce/message/v1/send_message", async (route) => {
    const request = route.request();
    fullReport.blockedSendAttempts.push({
      url: request.url(),
      method: request.method(),
      body: safeJsonParse(request.postData(), request.postData() || ""),
    });
    await route.abort();
  });

  await page.route("**/commerce/message/v1/update_conversation", async (route) => {
    const request = route.request();
    fullReport.blockedSendAttempts.push({
      url: request.url(),
      method: request.method(),
      body: safeJsonParse(request.postData(), request.postData() || ""),
      reason: "Unexpected browser-side provider read mutation; expected only the guarded Edge Function to call eBay.",
    });
    await route.abort();
  });

  try {
    await page.goto("/email-triage.html");
    await expect(page.locator("#ebay-conversation-status")).toBeVisible({ timeout: 30000 });
    await waitForMailboxReady(page);
    report.add("Open local app as authenticated admin", "passed", {
      url: page.url(),
      status: await page.locator("#ebay-conversation-status").innerText(),
    });

    const session = await getAdminSessionFromPage(page);
    const config = await getSupabaseConfigFromPage(page, env);
    const client = createReadonlyClient({
      ...config,
      accessToken: session.accessToken,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      useServiceRole: envFlag(env, "EMAIL_TRIAGE_USE_SERVICE_ROLE"),
    });
    fullReport.usedServiceRole = client.usingServiceRole;

    const mailbox = await canonicalMailbox(client, { pageSize: 100 });
    const summaryText = await page.locator("#ebay-conversation-summary").innerText();
    const uiCanonical = extractMetric(summaryText, "Canonical");
    expect(uiCanonical).toBe(Number(mailbox.canonical_total));
    report.add("Mailbox canonical RPC counts match UI", "passed", {
      canonical_total: mailbox.canonical_total,
      matching_total: mailbox.matching_total,
      loaded_count: mailbox.loaded_count,
      uiSummary: summaryText,
    });

    const directUnclassified = await directUnclassifiedCount(client);
    const unclassifiedMailbox = await canonicalMailbox(client, { pageSize: 100, systemFilter: "unclassified" });
    const smartUnclassified = Number(mailbox.smart_folder_counts?.unclassified);
    const uiUnclassified = extractMetric(summaryText, "Unclassified");
    expect(Number.isFinite(smartUnclassified)).toBe(true);
    expect(smartUnclassified).toBe(directUnclassified.count);
    expect(Number(unclassifiedMailbox.matching_total)).toBe(directUnclassified.count);
    expect(uiUnclassified).toBe(directUnclassified.count);
    const classifiedRowsInUnclassifiedQueue = Array.isArray(unclassifiedMailbox.conversations)
      ? unclassifiedMailbox.conversations.filter((row) => row.classification?.id)
      : [];
    expect(classifiedRowsInUnclassifiedQueue, "Unclassified queue must not return rows with current classifications.").toHaveLength(0);
    report.add("Unclassified count and queue reconcile", "passed", {
      directCount: directUnclassified.count,
      directSource: directUnclassified.source,
      smartFolderCount: smartUnclassified,
      rpcMatchingTotal: unclassifiedMailbox.matching_total,
      uiUnclassified,
      queuedRows: Array.isArray(unclassifiedMailbox.conversations) ? unclassifiedMailbox.conversations.length : 0,
    });

    const firstConversation = Array.isArray(mailbox.conversations) ? mailbox.conversations[0] : null;
    if (firstConversation) {
      const searchTerm = chooseSearchTerm(firstConversation);
      if (searchTerm) {
        const expectedSearch = await canonicalMailbox(client, { pageSize: 100, searchTerms: [searchTerm] });
        await page.locator("#ebay-conversation-search").fill(searchTerm);
        await expect.poll(async () => {
          const text = await page.locator("#ebay-conversation-summary").innerText();
          return extractMetric(text, "Matching");
        }, { timeout: 30000 }).toBe(Number(expectedSearch.matching_total));
        report.add("Search behavior matches canonical RPC", "passed", {
          searchTerm,
          matching_total: expectedSearch.matching_total,
          loaded_count: expectedSearch.loaded_count,
        });
        await page.locator("#ebay-conversation-search-clear").click();
        await expect.poll(async () => {
          const text = await page.locator("#ebay-conversation-summary").innerText();
          return extractMetric(text, "Matching");
        }, { timeout: 30000 }).toBe(Number(mailbox.matching_total));
      }

      const folderKey = chooseSmartFolderKey(mailbox.smart_folder_counts);
      const expectedFolder = await canonicalMailbox(client, { pageSize: 100, systemFilter: folderKey });
      await smartFolderButton(page, folderKey).click();
      await expect.poll(async () => {
        const text = await page.locator("#ebay-conversation-summary").innerText();
        return extractMetric(text, "Matching");
      }, { timeout: 30000 }).toBe(Number(expectedFolder.matching_total));
      report.add("Smart folder behavior matches canonical RPC", "passed", {
        folderKey,
        folderLabel: SMART_FOLDER_LABELS[folderKey] || folderKey,
        matching_total: expectedFolder.matching_total,
        loaded_count: expectedFolder.loaded_count,
      });
      if (folderKey !== "all") {
        await smartFolderButton(page, "all").click();
        await expect.poll(async () => {
          const text = await page.locator("#ebay-conversation-summary").innerText();
          return extractMetric(text, "Matching");
        }, { timeout: 30000 }).toBe(Number(mailbox.matching_total));
      }
    } else {
      report.add("Search/filter/smart folder behavior", "skipped", {
        reason: "No canonical conversations are available.",
      });
    }

    await expandClassificationFilters(page);
    const nativeFolderEvidence = [];
    for (const [folderKey, expectation] of Object.entries(NATIVE_LABEL_FOLDER_EXPECTATIONS)) {
      const expectedByLabel = await canonicalMailbox(client, {
        pageSize: 100,
        classificationFilters: {
          [expectation.groupKey]: [expectation.value],
        },
      });
      const expectedCount = Number(expectedByLabel.matching_total || 0);
      await expect.poll(async () => {
        return folderCountTextToNumber(await smartFolderButton(page, folderKey).locator("b").innerText());
      }, {
        timeout: 30000,
        message: `${SMART_FOLDER_LABELS[folderKey]} count should equal ${expectation.label} label count.`,
      }).toBe(expectedCount);
      await smartFolderButton(page, folderKey).click();
      await waitForMatchingTotal(page, expectedCount);
      await expandClassificationFilters(page);
      await expect(classificationFilterInput(page, expectation.groupKey, expectation.value)).toBeChecked();
      nativeFolderEvidence.push({
        folderKey,
        folderLabel: SMART_FOLDER_LABELS[folderKey],
        requiredLabel: expectation.label,
        expectedCount,
        rpcMatchingTotal: expectedByLabel.matching_total,
      });
    }
    await smartFolderButton(page, "all").click();
    await waitForMatchingTotal(page, mailbox.matching_total);
    report.add("Native smart folders highlight exact labels and count consistently", "passed", {
      folders: nativeFolderEvidence,
    });

    const folderStamp = String(Date.now()).slice(-10);
    const aiFolderName = `P2E ${folderStamp} AI`;
    const systemFolderName = `P2E ${folderStamp} System`;
    const comboFolderName = `P2E ${folderStamp} Combo`;
    await createSmartFolderThroughUi(page, {
      name: aiFolderName,
      filters: [{ groupKey: "buyerFlags", value: "vip_buyer" }],
    });
    await createSmartFolderThroughUi(page, {
      name: systemFolderName,
      systemFilter: "has_media",
    });
    await createSmartFolderThroughUi(page, {
      name: comboFolderName,
      systemFilter: "members",
      filters: [{ groupKey: "buyerFlags", value: "vip_buyer" }],
    });
    await page.reload();
    await waitForMailboxReady(page);
    await expandClassificationFilters(page);
    await customSmartFolderButton(page, aiFolderName).click();
    await expandClassificationFilters(page);
    await expect(classificationFilterInput(page, "buyerFlags", "vip_buyer")).toBeChecked();
    await customSmartFolderButton(page, systemFolderName).click();
    await expandClassificationFilters(page);
    await expectSystemFilterActive(page, "has_media", true);
    await customSmartFolderButton(page, comboFolderName).click();
    await expandClassificationFilters(page);
    await expectSystemFilterActive(page, "members", true);
    await expect(classificationFilterInput(page, "buyerFlags", "vip_buyer")).toBeChecked();
    report.add("Custom smart folder create flow persists AI/system labels after reload", "passed", {
      aiFolderName,
      systemFolderName,
      comboFolderName,
    });

    await page.locator("#ebay-smart-folder-edit-toggle").click();
    await customSmartFolderButton(page, comboFolderName).click();
    const filterPanel = page.locator("#ebay-conversation-filter-panel");
    await expect(filterPanel).toContainText("SMART FOLDER EDIT MODE");
    await expect(filterPanel).toContainText(`Editing: ${comboFolderName}`);
    await setClassificationFilter(page, "buyerFlags", "vip_buyer", false);
    await filterPanel.locator("[data-ebay-smart-folder-edit-reset]").click();
    await expect(classificationFilterInput(page, "buyerFlags", "vip_buyer")).toBeChecked();
    await setClassificationFilter(page, "buyerFlags", "vip_buyer", false);
    await filterPanel.locator("[data-ebay-smart-folder-edit-save]").click();
    await expect(filterPanel).not.toContainText("SMART FOLDER EDIT MODE", { timeout: 30000 });
    await page.reload();
    await waitForMailboxReady(page);
    await expandClassificationFilters(page);
    await customSmartFolderButton(page, comboFolderName).click();
    await expandClassificationFilters(page);
    await expectSystemFilterActive(page, "members", true);
    await expect(classificationFilterInput(page, "buyerFlags", "vip_buyer")).not.toBeChecked();
    report.add("Custom smart folder edit draft reset/save persists after reload", "passed", {
      editedFolderName: comboFolderName,
      removedLabel: "VIP Buyer",
      retainedSystemLabel: "Members",
    });

    const selectedRow = page.locator(".ebay-conversation-row.is-selected[data-ebay-conversation-id]").first();
    const selectedConversationId = await selectedRow.getAttribute("data-ebay-conversation-id").catch(() => null);
    let messagesBefore = [];
    if (selectedConversationId) {
      messagesBefore = await conversationMessages(client, selectedConversationId);
      if (messagesBefore.length) {
        await expect.poll(async () => page.locator(".ebay-chat-timeline .ebay-message-row").count(), {
          timeout: 30000,
        }).toBeGreaterThan(0);
      }
      report.add("Selected conversation message persistence is visible", "passed", {
        conversation_id: selectedConversationId,
        messages: summarizeMessages(messagesBefore),
        uiMessageRows: await page.locator(".ebay-chat-timeline .ebay-message-row").count(),
      });
    } else {
      report.add("Selected conversation message persistence is visible", "skipped", {
        reason: "No selected conversation row is available.",
      });
    }

    await ensureDashboardOpen(page);
    await page.locator("#refresh-operational-dashboard").click();
    await expect(page.locator("#operational-dashboard-status")).toContainText(/refreshed|failed/i, { timeout: 60000 });
    const dashboardStatus = await page.locator("#operational-dashboard-status").innerText();
    expect(dashboardStatus).not.toMatch(/failed/i);
    report.add("Dashboard events/counts render", "passed", {
      dashboardStatus,
      recentEvents: (await recentActivityEvents(client, { limit: 10 })).map((event) => ({
        id: event.id,
        event_type: event.event_type,
        status: event.status,
        title: event.title,
        created_at: event.created_at,
      })),
    });

    let readRows = [];
    let readStateRowsError = null;
    try {
      readRows = await readStateRows(client, { limit: 1000 });
    } catch (error) {
      readStateRowsError = error.message || String(error);
    }
    const readStateSummary = summarizeReadStateRows(readRows);
    const dashboardTextForReadState = await page.locator("#operational-dashboard").innerText();
    const normalizedReadDashboardText = dashboardTextForReadState.toLowerCase();
    expect(normalizedReadDashboardText).toContain("provider unread");
    expect(normalizedReadDashboardText).toContain("og unread");
    expect(normalizedReadDashboardText).toContain("read sync pending");
    expect(normalizedReadDashboardText).toContain("read sync failed");
    if (selectedConversationId) {
      const detailText = await page.locator("#ebay-conversation-detail").innerText();
      const normalizedDetailText = detailText.toLowerCase();
      expect(normalizedDetailText).toContain("ebay");
      expect(normalizedDetailText).toContain("og");
      expect(normalizedDetailText).toContain("read sync");
      await page.locator(".ebay-read-sync-actions > summary").click();
      const expandedDetailText = await page.locator("#ebay-conversation-detail").innerText();
      expect(expandedDetailText).toContain("Retry Sync Read");
      expect(expandedDetailText).toContain("Sync Unread");
    }
    const mailboxRowsWithProviderState = Array.isArray(mailbox.conversations)
      ? mailbox.conversations.filter((row) => Object.prototype.hasOwnProperty.call(row, "provider_read_state"))
      : [];
    const readStateSchemaAvailable = !readStateRowsError &&
      Array.isArray(mailbox.conversations) &&
      mailboxRowsWithProviderState.length === mailbox.conversations.length;
    if (readStateRowsError) {
      expect(normalizedReadDashboardText).toContain("read schema pending");
    } else {
      expect(readStateSchemaAvailable).toBe(true);
    }
    report.add("Read/unread state displays truthfully", readStateSchemaAvailable ? "passed" : "skipped", {
      reason: readStateSchemaAvailable ? undefined : "Provider read-state migration has not been applied to this Supabase project yet.",
      dashboardLabelsFound: true,
      selectedConversationId,
      mailboxRpcVersion: mailbox.rpc_version,
      mailboxConversationsWithProviderState: mailboxRowsWithProviderState.length,
      readStateRowsError,
      sampledReadState: readStateSummary,
    });

    const liveStartedAt = new Date().toISOString();

    if (envFlag(env, "EMAIL_TRIAGE_RUN_SYNC_RECENT")) {
      const targetEbayConversationId = String(env.EMAIL_TRIAGE_SYNC_RECENT_TARGET_EBAY_CONVERSATION_ID || "").trim();
      const targetConversationType = String(env.EMAIL_TRIAGE_SYNC_RECENT_TARGET_CONVERSATION_TYPE || "FROM_MEMBERS").trim();
      const expectTargetUpdate = envFlag(env, "EMAIL_TRIAGE_EXPECT_SYNC_RECENT_TARGET_UPDATE");
      const expectTargetSweep = envFlag(env, "EMAIL_TRIAGE_EXPECT_SYNC_RECENT_TARGET_SWEEP");
      const targetBefore = targetEbayConversationId
        ? await conversationByEbayId(client, targetEbayConversationId, targetConversationType)
        : null;
      const targetMessagesBefore = targetBefore
        ? await conversationMessages(client, targetBefore.id)
        : [];
      let exchange = await waitForFunctionResponseOrTimeout(
        page,
        "ebay-message-sync",
        (body) => body?.runType === "incremental" && body?.checkpointScope === "commerce_message_latest_sync",
        () => page.locator("#ebay-conversation-sync").click(),
        180000,
      );
      if (exchange.timedOutWaitingForBrowserResponse) {
        const durableRuns = await recentSyncRuns(client, { since: liveStartedAt, limit: 10 });
        const durableRun = latestRun(durableRuns, (run) => (
          run.run_type === "incremental" &&
          run.status === "succeeded" &&
          run.metadata?.checkpointScope === "commerce_message_latest_sync"
        ));
        expect(durableRun, "Expected a durable successful Sync Recent run after the browser response timed out.").toBeTruthy();
        exchange = syncExchangeFromDurableRun(durableRun, {
          runType: "incremental",
          checkpointScope: "commerce_message_latest_sync",
        });
      }
      assertSyncSafety(exchange);
      await assertSyncBannerMatches(page, exchange);
      const counters = exchange.response?.counters || {};
      expect(counters).toHaveProperty("canonicalDetailSweepCandidates");
      expect(counters).toHaveProperty("canonicalDetailSweepRefreshed");
      expect(counters).toHaveProperty("canonicalDetailSweepConversationIds");

      let targetAfter = null;
      let targetMessagesAfter = [];
      let targetSwept = false;
      let targetProcessedByProviderList = false;
      if (targetEbayConversationId) {
        expect(targetBefore, `Expected target eBay conversation ${targetEbayConversationId} to already exist in canonical storage.`).toBeTruthy();
        targetAfter = await conversationByEbayId(client, targetEbayConversationId, targetConversationType);
        targetMessagesAfter = targetAfter ? await conversationMessages(client, targetAfter.id) : [];
        targetSwept = Array.isArray(counters.canonicalDetailSweepConversationIds) &&
          counters.canonicalDetailSweepConversationIds.includes(targetEbayConversationId);
        targetProcessedByProviderList = Array.isArray(counters.conversationIds) &&
          counters.conversationIds.includes(targetEbayConversationId);
        if (expectTargetSweep) {
          expect(targetSwept, `Expected Sync Recent canonical detail sweep to refresh ${targetEbayConversationId}.`).toBe(true);
        } else {
          expect(
            targetSwept || targetProcessedByProviderList,
            `Expected Sync Recent to process ${targetEbayConversationId} via provider list or canonical detail sweep.`,
          ).toBe(true);
        }
        expect(targetAfter?.last_detail_synced_at || null).not.toEqual(targetBefore?.last_detail_synced_at || null);
        if (expectTargetUpdate) {
          expect(conversationStateAdvanced(targetBefore, targetAfter)).toBe(true);
          expect(summarizeMessages(targetMessagesAfter)).not.toEqual(summarizeMessages(targetMessagesBefore));
        }
      }
      report.add("Sync recent mailbox", "passed", {
        request: exchange.request,
        response: summarizeSyncPayload(exchange.response),
        targetConversation: targetEbayConversationId
          ? {
            ebayConversationId: targetEbayConversationId,
            conversationType: targetConversationType,
            expectedContentUpdate: expectTargetUpdate,
            sweptByCanonicalDetailSweep: targetSwept,
            processedByProviderList: targetProcessedByProviderList,
            before: summarizeConversationState(targetBefore),
            after: summarizeConversationState(targetAfter),
            messagesBefore: summarizeMessages(targetMessagesBefore),
            messagesAfter: summarizeMessages(targetMessagesAfter),
          }
          : null,
      });
    } else {
      report.add("Sync recent mailbox", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_SYNC_RECENT=true to run this live write-to-Supabase check.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_REFRESH_TIMELINE") && selectedConversationId) {
      const before = await conversationMessages(client, selectedConversationId);
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-message-sync",
        (body) => Boolean(body?.conversationId),
        () => page.locator('[data-ebay-detail-action="refresh-messages"]').click(),
        180000,
      );
      assertSyncSafety(exchange);
      await assertSyncBannerMatches(page, exchange);
      const after = await conversationMessages(client, selectedConversationId);
      const counters = exchange.response?.counters || {};
      const providerReturnedNewer = Number(counters.messagesInserted || 0) + Number(counters.messagesUpdated || 0) > 0;
      if (providerReturnedNewer) {
        expect(summarizeMessages(after)).not.toEqual(summarizeMessages(before));
      }
      report.add("Refresh Timeline", "passed", {
        request: exchange.request,
        response: summarizeSyncPayload(exchange.response),
        before: summarizeMessages(before),
        after: summarizeMessages(after),
        persistenceFinding: providerReturnedNewer
          ? "Provider returned inserted/updated messages and persisted message summary changed."
          : "Provider returned no inserted/updated messages; stable persistence is expected.",
      });
    } else {
      report.add("Refresh Timeline", "skipped", {
        reason: selectedConversationId
          ? "Set EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true to run this live write-to-Supabase check."
          : "No selected conversation row is available.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC") && selectedConversationId) {
      if (env.EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC !== "I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE") {
        report.add("Provider read-state update", "skipped", {
          reason: "Set EMAIL_TRIAGE_CONFIRM_PROVIDER_READ_SYNC=I_UNDERSTAND_THIS_MUTATES_EBAY_READ_STATE to intentionally mutate eBay read/unread state.",
        });
      } else {
        const requestedReadState = String(env.EMAIL_TRIAGE_PROVIDER_READ_SYNC_STATE || "read").toLowerCase() === "unread" ? "unread" : "read";
        const beforeRows = await readStateRows(client, { limit: 1000 });
        const before = beforeRows.find((row) => row.id === selectedConversationId) || null;
        const exchange = await waitForFunctionResponse(
          page,
          "ebay-message-read-sync",
          (body) => body?.mode === "set_read_state" && body?.conversationId === selectedConversationId,
          () => page.locator(`[data-ebay-detail-action="sync-provider-read"][data-ebay-read-state="${requestedReadState}"]`).click(),
          120000,
        );
        assertProviderReadSyncSafety(exchange);
        await expect(page.locator("#ebay-conversation-sync-result")).toContainText(/provider read state synced|eBay mutation: true/i, { timeout: 60000 });
        const afterRows = await readStateRows(client, { limit: 1000 });
        const after = afterRows.find((row) => row.id === selectedConversationId) || null;
        expect(after?.provider_read_state).toBe(requestedReadState);
        expect(after?.local_read_state).toBe(requestedReadState);
        expect(after?.pending_provider_update).toBe(false);
        expect(after?.read_sync_status).toBe("synced");
        report.add("Provider read-state update", "passed", {
          request: exchange.request,
          response: redact(exchange.response),
          requestedReadState,
          before: summarizeConversationState(before),
          after: summarizeConversationState(after),
        });
      }
    } else {
      report.add("Provider read-state update", "skipped", {
        reason: selectedConversationId
          ? "Set EMAIL_TRIAGE_RUN_PROVIDER_READ_SYNC=true plus confirmation env to intentionally mutate eBay read/unread state."
          : "No selected conversation row is available.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED")) {
      const before = await canonicalMailbox(client, { pageSize: 1 });
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-conversation-classify",
        (body) => body?.mode === "classify_recent" && body?.force !== true,
        () => page.locator("#ebay-conversation-classify-recent").click(),
        180000,
      );
      assertClassificationSafety(exchange);
      await expect(page.locator("#ebay-conversation-sync-result")).toContainText(/Classify new|finished|timed out/i, { timeout: 60000 });
      const after = await canonicalMailbox(client, { pageSize: 1 });
      const beforeCount = Number(before.smart_folder_counts?.unclassified || 0);
      const afterCount = Number(after.smart_folder_counts?.unclassified || 0);
      report.add("Classify New", "passed", {
        request: exchange.request,
        response: summarizeClassificationPayload(exchange.response),
        unclassifiedBefore: beforeCount,
        unclassifiedAfter: afterCount,
        countFinding: afterCount < beforeCount
          ? "Unclassified count decreased."
          : "Unclassified count did not decrease; this is acceptable when no eligible unclassified rows exist, rows were skipped, or classifications did not change the canonical queue.",
      });
    } else {
      report.add("Classify New", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true to run this classification write check.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT")) {
      const reclassifyStartedAt = new Date().toISOString();
      const exchange = await waitForFunctionResponseOrTimeout(
        page,
        "ebay-conversation-classify",
        (body) => body?.mode === "classify_recent" && body?.force === true,
        async () => {
          await openEbayMaintenanceActions(page);
          await page.locator("#ebay-conversation-reclassify-all").click();
        },
        240000,
      );
      expect(exchange.timedOutWaitingForBrowserResponse, "Reclassify recent 20 should return inside the operator workflow without reconciliation rescue.").not.toBe(true);
      assertClassificationSafety(exchange);
      await expect(page.locator("#ebay-conversation-sync-result")).toContainText(/Reclassify recent 20|finished/i, { timeout: 90000 });
      await page.locator("#refresh-operational-dashboard").click();
      await expect(page.locator("#operational-dashboard-status")).toContainText(/refreshed|failed/i, { timeout: 60000 });
      let runs = [];
      let run = null;
      await expect.poll(async () => {
        await page.evaluate(async () => {
          const { error } = await window.supabase.rpc("reconcile_ebay_conversation_classification_runs", {
            _stale_after_seconds: 90,
          });
          if (error) throw new Error(error.message || "classification_run_reconciliation_failed");
        });
        runs = await recentClassificationRuns(client, { since: reclassifyStartedAt, limit: 10 });
        run = latestRun(runs, (row) => row.run_mode === RECLASSIFY_RECENT_RUN_MODE);
        return run?.status || "missing";
      }, {
        timeout: 240000,
        intervals: [2000, 5000, 10000],
        message: "Reclassify Recent 20 durable run should terminalize.",
      }).toMatch(/^(succeeded|partial_success|failed)$/);
      expect(run, "Reclassify Recent 20 durable run should exist.").toBeTruthy();
      expect(Number(run.requested_limit || 0)).toBeLessThanOrEqual(RECLASSIFY_RECENT_LIMIT);
      expect(CLASSIFICATION_TERMINAL_STATUSES).toContain(run.status);
      expect(run.completed_at, "Terminal reclassify run should populate completed_at.").toBeTruthy();
      expect(Number(run.duration_ms || 0), "Terminal reclassify run should populate duration_ms.").toBeGreaterThanOrEqual(0);
      expect(Number(run.processed_count || 0)).toBe(Number(run.classified_count || 0) + Number(run.failed_count || 0) + Number(run.skipped_count || 0));
      const openReclassifyRuns = runs.filter((row) =>
        row.run_mode === RECLASSIFY_RECENT_RUN_MODE &&
        ["pending", "running"].includes(row.status)
      );
      expect(openReclassifyRuns, "No stale pending/running reclassify run should remain from this validation window.").toHaveLength(0);
      const events = await recentActivityEvents(client, { since: reclassifyStartedAt, limit: 100 });
      const startedEvents = events.filter((event) =>
        event.event_type === "conversation_classified" &&
        event.title === "Classification Batch Started" &&
        eventRunId(event) === run.id
      );
      const terminalEvents = events.filter((event) =>
        event.event_type === "conversation_classified" &&
        Object.values(CLASSIFICATION_TERMINAL_TITLES).includes(event.title) &&
        eventRunId(event) === run.id
      );
      expect(startedEvents, "Reclassify started event should be durable and singular.").toHaveLength(1);
      expect(terminalEvents, "Terminal reclassify run should have exactly one terminal event.").toHaveLength(1);
      const terminalEvent = terminalEvents[0];
      expect(terminalEvent.title).toBe(CLASSIFICATION_TERMINAL_TITLES[run.status]);
      expect(terminalEvent.status).toBe(run.status);
      expect(terminalEvent.metadata?.classification_run?.completed_at || terminalEvent.metadata?.completed_at).toBeTruthy();
      expect(terminalEvent.metadata?.safety?.ebay_mutation_performed).toBe(false);
      expect(Number(terminalEvent.metadata?.safety?.automatic_responses_sent || 0)).toBe(0);
      const runClassifications = await classificationsForRun(client, run.id);
      expect(runClassifications.length).toBe(Number(run.classified_count || 0));
      await page.locator("#refresh-operational-dashboard").click();
      await expect(page.locator("#operational-dashboard-status")).toContainText(/refreshed|failed/i, { timeout: 60000 });
      const dashboardText = await page.locator("#operational-dashboard").innerText();
      const normalizedDashboardText = dashboardText.toLowerCase();
      expect(dashboardText).toContain("Latest Classification Batch");
      expect(normalizedDashboardText).toContain("terminal status");
      expect(normalizedDashboardText).toContain("duration");
      expect(normalizedDashboardText).toContain(run.status.replace("_", " "));
      const sendAttempts = await recentSendAttempts(client, { since: reclassifyStartedAt, limit: 20 });
      expect(sendAttempts, "Reclassify Recent 20 should not create send attempts.").toHaveLength(0);
      report.add("Reclassify recent 20", "passed", {
        request: exchange.request,
        response: summarizeClassificationPayload(exchange.response),
        browserResponseTimedOut: exchange.timedOutWaitingForBrowserResponse === true,
        durableRun: run,
        startedEvent: startedEvents[0] ? {
          id: startedEvents[0].id,
          status: startedEvents[0].status,
          title: startedEvents[0].title,
        } : null,
        terminalEvent: terminalEvent ? {
          id: terminalEvent.id,
          status: terminalEvent.status,
          title: terminalEvent.title,
        } : null,
        classificationsForRun: runClassifications.length,
        dashboardTerminalStatusMatched: normalizedDashboardText.includes(run.status.replace("_", " ")),
        sendAttemptsCreated: sendAttempts.length,
      });
    } else {
      report.add("Reclassify recent 20", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true to run this bounded classification write check.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE")) {
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-message-sync",
        (body) => body?.runType === "backfill" && body?.classificationMode === "none",
        async () => {
          await openEbayMaintenanceActions(page);
          await page.locator("#ebay-conversation-backfill").click();
        },
        300000,
      );
      assertSyncSafety(exchange);
      await assertSyncBannerMatches(page, exchange);
      report.add("Backfill archive status visibility", "passed", {
        request: exchange.request,
        response: summarizeSyncPayload(exchange.response),
        checkpoints: await backfillCheckpoints(client),
      });
    } else {
      report.add("Backfill archive status visibility", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=true to run one historical archive chunk.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW")) {
      const backfillStartedAt = new Date().toISOString();
      const mailboxBefore = await canonicalMailbox(client, { pageSize: 1 });
      const beforeTotal = Number(mailboxBefore.canonical_total || 0);
      const exchange = await waitForFunctionResponseOrTimeout(
        page,
        "ebay-message-sync",
        (body) => body?.runType === "backfill" && body?.classificationMode === "classify_new",
        async () => {
          await openEbayMaintenanceActions(page);
          await page.locator("#ebay-conversation-backfill-classify-new").click();
        },
        300000,
      );
      assertSyncSafety(exchange);
      await assertSyncBannerMatches(page, exchange);
      await page.locator("#refresh-operational-dashboard").click();
      await expect(page.locator("#operational-dashboard-status")).toContainText(/refreshed|failed/i, { timeout: 60000 });
      const mailboxAfter = await canonicalMailbox(client, { pageSize: 1 });
      const afterTotal = Number(mailboxAfter.canonical_total || 0);
      expect(afterTotal).toBeGreaterThanOrEqual(beforeTotal);
      const runs = await recentSyncRuns(client, { since: backfillStartedAt, limit: 20 });
      const run = latestRun(runs, (row) => row.run_type === "backfill" && (
        row.metadata?.classificationMode === "classify_new" ||
        row.metadata?.classification_mode === "classify_new"
      ));
      expect(run, "Backfill + Classify New sync run should exist.").toBeTruthy();
      expect(run.status, "Backfill ingest run should succeed durably even when classifications are partial.").toBe("succeeded");
      const metadata = run.metadata || {};
      const classificationSucceeded = Number(metadata.classificationSucceeded ?? metadata.classification_succeeded ?? 0);
      const classificationFailed = Number(metadata.classificationFailed ?? metadata.classification_failed ?? 0);
      const classificationSkipped = Number(metadata.classificationSkipped ?? metadata.classification_skipped ?? 0);
      const classificationProcessed = Number(metadata.classificationProcessed ?? metadata.classification_processed ?? 0);
      expect(classificationProcessed).toBe(classificationSucceeded + classificationFailed);
      const events = await recentActivityEvents(client, { since: backfillStartedAt, limit: 50 });
      const backfillEvent = events.find((event) =>
        event.sync_run_id === run.id &&
        ["message_backfill_progress", "message_backfill_completed"].includes(event.event_type)
      );
      expect(backfillEvent, "Backfill run should have a progress/completion event.").toBeTruthy();
      if (classificationFailed > 0 && classificationSucceeded > 0) {
        expect(backfillEvent.status).toBe("partial_success");
      }
      report.add("Backfill + classify new", "passed", {
        request: exchange.request,
        response: summarizeSyncPayload(exchange.response),
        browserResponseTimedOut: exchange.timedOutWaitingForBrowserResponse === true,
        canonicalBefore: beforeTotal,
        canonicalAfter: afterTotal,
        durableRun: run,
        classificationCounts: {
          processed: classificationProcessed,
          succeeded: classificationSucceeded,
          failed: classificationFailed,
          skipped: classificationSkipped,
        },
        event: backfillEvent ? {
          id: backfillEvent.id,
          event_type: backfillEvent.event_type,
          status: backfillEvent.status,
          title: backfillEvent.title,
        } : null,
        checkpoints: await backfillCheckpoints(client),
      });
    } else {
      report.add("Backfill + classify new", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true to run one backfill chunk with classify_new.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL")) {
      if (env.EMAIL_TRIAGE_CONFIRM_FULL_RECLASSIFY_ALL !== "I_UNDERSTAND_THIS_RECLASSIFIES_ARCHIVE") {
        report.add("Backfill + reclassify all", "skipped", {
          reason: "Set EMAIL_TRIAGE_CONFIRM_FULL_RECLASSIFY_ALL=I_UNDERSTAND_THIS_RECLASSIFIES_ARCHIVE to run this expensive full-archive reclassification chunk.",
        });
      } else {
        page.once("dialog", (dialog) => dialog.accept());
        const exchange = await waitForFunctionResponse(
          page,
          "ebay-message-sync",
          (body) => body?.runType === "backfill" && body?.classificationMode === "reclassify_all",
          async () => {
            await openEbayMaintenanceActions(page);
            await page.locator("#ebay-conversation-backfill-reclassify-all").click();
          },
          300000,
        );
        assertSyncSafety(exchange);
        await assertSyncBannerMatches(page, exchange);
        report.add("Backfill + reclassify all", "passed", {
          request: exchange.request,
          response: summarizeSyncPayload(exchange.response),
          checkpoints: await backfillCheckpoints(client),
        });
      }
    } else {
      report.add("Backfill + reclassify all", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=true plus the confirmation env to run one expensive full-archive reclassification chunk.",
      });
    }

    await ensureDashboardOpen(page);
    await page.locator("#refresh-operational-dashboard").click();
    await expect(page.locator("#operational-dashboard-status")).toContainText(/refreshed|failed/i, { timeout: 60000 });
    const liveEvents = await recentActivityEvents(client, { since: liveStartedAt, limit: 50 });
    const liveRuns = await recentSyncRuns(client, { since: liveStartedAt, limit: 20 });
    report.add("Latest operational events match performed actions", "passed", {
      since: liveStartedAt,
      events: liveEvents.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        status: event.status,
        title: event.title,
        sync_run_id: event.sync_run_id,
        created_at: event.created_at,
      })),
      syncRuns: liveRuns.map((run) => ({
        id: run.id,
        run_type: run.run_type,
        status: run.status,
        pages_fetched: run.pages_fetched,
        conversations_seen: run.conversations_seen,
        messages_seen: run.messages_seen,
        completed_at: run.completed_at,
      })),
    });

    expect(fullReport.blockedSendAttempts).toHaveLength(0);
  } finally {
    fullReport.finishedAt = new Date().toISOString();
    const reportPath = await writeReport(fullReport);
    console.log(`Email triage regression report: ${path.relative(repoRoot, reportPath)}`);
  }
});
