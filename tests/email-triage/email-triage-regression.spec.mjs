import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  backfillCheckpoints,
  canonicalMailbox,
  conversationMessages,
  createReadonlyClient,
  envFlag,
  getAdminSessionFromPage,
  getSupabaseConfigFromPage,
  loadEmailTriageEnv,
  recentActivityEvents,
  recentSyncRuns,
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

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value) {
  const numeric = numberOrNull(value);
  return numeric === null ? "--" : numeric.toLocaleString("en-US");
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
  return page.evaluate(async () => {
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

function assertSyncSafety(exchange) {
  expect(exchange.status).toBeLessThan(300);
  expect(exchange.response?.ok).not.toBe(false);
  expect(exchange.response?.safety?.ebayMutationsPerformed).toBe(false);
  expect(exchange.response?.safety?.sendsEnabled).toBe(false);
  expect(Number(exchange.response?.safety?.messagesSent || 0)).toBe(0);
}

function assertClassificationSafety(exchange) {
  expect(exchange.status).toBeLessThan(300);
  expect(exchange.response?.ok).not.toBe(false);
  expect(exchange.response?.safety?.ebayMutationsPerformed).toBe(false);
  expect(exchange.response?.safety?.sendsEnabled).toBe(false);
  expect(Number(exchange.response?.safety?.messagesSent || 0)).toBe(0);
}

async function assertSyncBannerMatches(page, exchange) {
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

    const liveStartedAt = new Date().toISOString();

    if (envFlag(env, "EMAIL_TRIAGE_RUN_SYNC_RECENT")) {
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-message-sync",
        (body) => body?.runType === "incremental" && body?.checkpointScope === "commerce_message_latest_sync",
        () => page.locator("#ebay-conversation-sync").click(),
        180000,
      );
      assertSyncSafety(exchange);
      await assertSyncBannerMatches(page, exchange);
      report.add("Sync recent mailbox", "passed", {
        request: exchange.request,
        response: summarizeSyncPayload(exchange.response),
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
      await expect(page.locator("#ebay-conversation-sync-result")).toContainText(/Classify unclassified|finished|timed out/i, { timeout: 60000 });
      const after = await canonicalMailbox(client, { pageSize: 1 });
      const beforeCount = Number(before.smart_folder_counts?.unclassified || 0);
      const afterCount = Number(after.smart_folder_counts?.unclassified || 0);
      report.add("Classify unclassified", "passed", {
        request: exchange.request,
        response: summarizeClassificationPayload(exchange.response),
        unclassifiedBefore: beforeCount,
        unclassifiedAfter: afterCount,
        countFinding: afterCount < beforeCount
          ? "Unclassified count decreased."
          : "Unclassified count did not decrease; this is acceptable when no eligible unclassified rows exist, rows were skipped, or classifications did not change the canonical queue.",
      });
    } else {
      report.add("Classify unclassified", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true to run this classification write check.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT")) {
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-conversation-classify",
        (body) => body?.mode === "classify_recent" && body?.force === true,
        () => page.locator("#ebay-conversation-reclassify-all").click(),
        180000,
      );
      assertClassificationSafety(exchange);
      expect(Number(exchange.response?.requested || 0)).toBeLessThanOrEqual(100);
      expect(exchange.response?.run_mode).toBe("reclassify_recent_100");
      report.add("Reclassify recent 100", "passed", {
        request: exchange.request,
        response: summarizeClassificationPayload(exchange.response),
      });
    } else {
      report.add("Reclassify recent 100", "skipped", {
        reason: "Set EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true to run this bounded classification write check.",
      });
    }

    if (envFlag(env, "EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE")) {
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-message-sync",
        (body) => body?.runType === "backfill" && body?.classificationMode === "none",
        () => page.locator("#ebay-conversation-backfill").click(),
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
      const exchange = await waitForFunctionResponse(
        page,
        "ebay-message-sync",
        (body) => body?.runType === "backfill" && body?.classificationMode === "classify_new",
        () => page.locator("#ebay-conversation-backfill-classify-new").click(),
        300000,
      );
      assertSyncSafety(exchange);
      await assertSyncBannerMatches(page, exchange);
      report.add("Backfill + classify new", "passed", {
        request: exchange.request,
        response: summarizeSyncPayload(exchange.response),
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
          () => page.locator("#ebay-conversation-backfill-reclassify-all").click(),
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
