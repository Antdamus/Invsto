import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(harnessDir, "../..");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value.replace(/\\n/g, "\n");
  }
  return out;
}

export function loadEmailTriageEnv() {
  const files = [
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.codex"),
    path.join(harnessDir, ".env.local"),
    path.join(harnessDir, ".env.codex"),
  ];
  const fileEnv = files.reduce((merged, filePath) => ({
    ...merged,
    ...parseEnvFile(filePath),
  }), {});
  return {
    ...fileEnv,
    ...process.env,
  };
}

export function resolveHarnessPath(value, fallback) {
  const raw = value || fallback;
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

export function envFlag(env, name, fallback = false) {
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value);
}

export function safeJsonParse(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function redact(value) {
  if (Array.isArray(value)) return value.slice(0, 25).map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/authorization|password|secret|service.*role|token|apikey|api_key/i.test(key)) {
      out[key] = "[redacted]";
    } else if (/message_body|raw_detail_metadata|raw_message_metadata/i.test(key)) {
      out[key] = "[omitted]";
    } else {
      out[key] = redact(entry);
    }
  }
  return out;
}

export async function getAdminSessionFromPage(page) {
  const session = await page.evaluate(async () => {
    const result = await window.supabase?.auth?.getSession?.();
    const active = result?.data?.session;
    return active ? {
      accessToken: active.access_token,
      expiresAt: active.expires_at,
      user: {
        id: active.user?.id || null,
        email: active.user?.email || null,
      },
    } : null;
  });
  if (!session?.accessToken) {
    throw new Error("No Supabase admin browser session is available.");
  }
  return session;
}

export async function getSupabaseConfigFromPage(page, env = loadEmailTriageEnv()) {
  const fromPage = await page.evaluate(() => ({
    supabaseUrl: window.SUPABASE_URL || "",
    anonKey: window.SUPABASE_ANON_KEY || "",
  }));
  const supabaseUrl = env.SUPABASE_URL || env.EMAIL_TRIAGE_SUPABASE_URL || fromPage.supabaseUrl;
  const anonKey = env.SUPABASE_ANON_KEY || env.EMAIL_TRIAGE_SUPABASE_ANON_KEY || fromPage.anonKey;
  if (!supabaseUrl) throw new Error("Missing Supabase URL.");
  if (!anonKey && !envFlag(env, "EMAIL_TRIAGE_USE_SERVICE_ROLE")) {
    throw new Error("Missing Supabase anon key for authenticated read-only checks.");
  }
  return { supabaseUrl, anonKey };
}

export function createReadonlyClient(options = {}) {
  const {
    supabaseUrl,
    anonKey,
    accessToken,
    serviceRoleKey,
    useServiceRole = false,
  } = options;

  if (!supabaseUrl) throw new Error("Supabase URL is required.");
  if (useServiceRole && !serviceRoleKey) {
    throw new Error("EMAIL_TRIAGE_USE_SERVICE_ROLE=true requires SUPABASE_SERVICE_ROLE_KEY.");
  }
  if (!useServiceRole && !accessToken) {
    throw new Error("Authenticated read-only checks require a browser session access token.");
  }

  const credential = useServiceRole ? serviceRoleKey : accessToken;
  const apiKey = useServiceRole ? serviceRoleKey : anonKey;
  const baseUrl = supabaseUrl.replace(/\/+$/, "");

  async function request(method, pathname, { body, searchParams } = {}) {
    const url = new URL(`${baseUrl}${pathname}`);
    if (searchParams) {
      for (const [key, value] of Object.entries(searchParams)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = safeJsonParse(text, text);
    if (!response.ok) {
      const error = new Error(`Supabase REST ${method} ${pathname} failed with ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return {
    usingServiceRole: useServiceRole,
    rpc(name, body) {
      return request("POST", `/rest/v1/rpc/${name}`, { body });
    },
    select(table, searchParams) {
      return request("GET", `/rest/v1/${table}`, { searchParams });
    },
  };
}

export async function canonicalMailbox(client, options = {}) {
  return client.rpc("get_ebay_canonical_mailbox_v2", {
    _page_size: Number(options.pageSize || 100),
    _offset: Number(options.offset || 0),
    _system_filter: options.systemFilter || "all",
    _search_terms: Array.isArray(options.searchTerms) ? options.searchTerms : [],
    _structured_filters: options.structuredFilters || {},
    _classification_filters: options.classificationFilters || {},
  });
}

export async function conversationMessages(client, conversationId) {
  if (!conversationId) return [];
  return client.select("ebay_conversation_messages", {
    select: [
      "id",
      "conversation_id",
      "ebay_message_id",
      "sender_username",
      "recipient_username",
      "direction",
      "subject",
      "message_body_preview",
      "read_status",
      "is_read",
      "created_at_ebay",
      "created_at",
    ].join(","),
    conversation_id: `eq.${conversationId}`,
    order: "created_at_ebay.asc.nullslast,created_at.asc",
    limit: "200",
  });
}

export async function conversationByEbayId(client, ebayConversationId, conversationType = "FROM_MEMBERS") {
  const id = String(ebayConversationId || "").trim();
  if (!id) return null;
  const rows = await client.select("ebay_conversations", {
    select: [
      "id",
      "ebay_conversation_id",
      "conversation_type",
      "other_party_username",
      "latest_message_id",
      "latest_message_created_at",
      "latest_message_preview",
      "message_count",
      "unread_count",
      "provider_read_state",
      "local_read_state",
      "pending_provider_update",
      "last_provider_seen_at",
      "last_local_read_at",
      "last_read_sync_at",
      "read_sync_status",
      "read_sync_error",
      "last_detail_synced_at",
      "updated_at",
    ].join(","),
    ebay_conversation_id: `eq.${id}`,
    conversation_type: `eq.${conversationType}`,
    limit: "1",
  });
  return rows?.[0] || null;
}

export async function readStateRows(client, options = {}) {
  return client.select("ebay_conversations", {
    select: [
      "id",
      "ebay_conversation_id",
      "conversation_type",
      "unread_count",
      "provider_read_state",
      "local_read_state",
      "pending_provider_update",
      "last_provider_seen_at",
      "last_local_read_at",
      "last_read_sync_at",
      "read_sync_status",
      "read_sync_error",
      "updated_at",
    ].join(","),
    order: "updated_at.desc",
    limit: String(options.limit || 1000),
  });
}

export async function recentActivityEvents(client, options = {}) {
  const params = {
    select: "id,event_type,status,title,detail,conversation_id,sync_run_id,classification_id,metadata,created_at",
    order: "created_at.desc",
    limit: String(options.limit || 30),
  };
  if (options.since) params.created_at = `gte.${options.since}`;
  return client.select("ebay_message_activity_events", params);
}

export async function recentSyncRuns(client, options = {}) {
  const params = {
    select: "id,run_type,status,conversation_page_limit,message_page_limit,pages_fetched,conversations_seen,conversations_inserted,conversations_updated,messages_seen,messages_inserted,messages_updated,metadata,started_at,completed_at",
    order: "started_at.desc",
    limit: String(options.limit || 10),
  };
  if (options.since) params.started_at = `gte.${options.since}`;
  return client.select("ebay_message_sync_runs", params);
}

export async function recentClassificationRuns(client, options = {}) {
  const params = {
    select: "id,run_mode,status,started_at,completed_at,requested_limit,target_count,processed_count,attempted_count,classified_count,failed_count,skipped_count,remaining_unclassified,unclassified_before,force,queue_source,canonical_queue,classification_version,prompt_version,model_name,duration_ms,conversation_ids,succeeded_conversation_ids,failed_conversation_ids,skipped_conversation_ids,failures,skipped_results,metadata",
    order: "started_at.desc",
    limit: String(options.limit || 10),
  };
  if (options.since) params.started_at = `gte.${options.since}`;
  return client.select("ebay_conversation_classification_runs", params);
}

export async function directUnclassifiedCount(client) {
  try {
    const count = await client.rpc("count_ebay_unclassified_conversations", {});
    const numeric = Number(count);
    if (Number.isFinite(numeric)) return {
      count: numeric,
      source: "count_ebay_unclassified_conversations",
    };
  } catch {
    // Older deployments may not have the dedicated RPC yet; fall through to
    // table reads so the regression report still exposes count drift.
  }

  const [conversations, classifications] = await Promise.all([
    client.select("ebay_conversations", {
      select: "id",
      limit: "5000",
    }),
    client.select("ebay_conversation_classifications", {
      select: "conversation_id",
      is_current: "eq.true",
      limit: "10000",
    }),
  ]);
  const classified = new Set((classifications || []).map((row) => String(row.conversation_id || "")).filter(Boolean));
  return {
    count: (conversations || []).filter((row) => !classified.has(String(row.id || ""))).length,
    source: "direct_table_anti_join",
  };
}

export async function classificationsForRun(client, runId) {
  if (!runId) return [];
  return client.select("ebay_conversation_classifications", {
    select: "id,conversation_id,is_current,classification_status,validation_metadata,created_at",
    "validation_metadata->>classification_run_id": `eq.${runId}`,
    order: "created_at.desc",
    limit: "250",
  });
}

export async function recentSendAttempts(client, options = {}) {
  const params = {
    select: "id,conversation_id,draft_id,approval_id,attempt_status,provider,idempotency_key,created_at",
    order: "created_at.desc",
    limit: String(options.limit || 50),
  };
  if (options.since) params.created_at = `gte.${options.since}`;
  return client.select("ebay_message_send_attempts", params);
}

export async function backfillCheckpoints(client) {
  return client.select("ebay_message_sync_checkpoints", {
    select: "id,checkpoint_scope,conversation_type,status,current_run_id,last_run_id,last_successful_sync_at,next_offset,total_available,pages_processed,conversations_processed,messages_processed,last_error_code,updated_at",
    order: "updated_at.desc",
    limit: "20",
  });
}

export function summarizeSyncPayload(payload = {}) {
  const counters = payload?.counters || {};
  return redact({
    ok: payload?.ok,
    error: payload?.error,
    phase: payload?.phase,
    mode: payload?.mode,
    runType: payload?.runType,
    classificationMode: payload?.classificationMode,
    runId: payload?.runId,
    status: payload?.status,
    canonicalTotalConversations: payload?.canonicalTotalConversations,
    unclassifiedBefore: payload?.unclassifiedBefore,
    unclassifiedAfter: payload?.unclassifiedAfter,
    remainingUnclassified: payload?.remainingUnclassified,
    counters: {
      pagesFetched: counters.pagesFetched,
      conversationsSeen: counters.conversationsSeen,
      conversationsInserted: counters.conversationsInserted,
      conversationsUpdated: counters.conversationsUpdated,
      conversationsUnchanged: counters.conversationsUnchanged,
      conversationsSkipped: counters.conversationsSkipped,
      conversationIds: counters.conversationIds,
      messagesSeen: counters.messagesSeen,
      messagesInserted: counters.messagesInserted,
      messagesUpdated: counters.messagesUpdated,
      messagesRechecked: counters.messagesRechecked,
      providerReadStateChanges: counters.providerReadStateChanges,
      pendingReadSyncConversations: counters.pendingReadSyncConversations,
      canonicalDetailSweepCandidates: counters.canonicalDetailSweepCandidates,
      canonicalDetailSweepRefreshed: counters.canonicalDetailSweepRefreshed,
      canonicalDetailSweepSkipped: counters.canonicalDetailSweepSkipped,
      canonicalDetailSweepFailed: counters.canonicalDetailSweepFailed,
      canonicalDetailSweepMessagesInserted: counters.canonicalDetailSweepMessagesInserted,
      canonicalDetailSweepMessagesUpdated: counters.canonicalDetailSweepMessagesUpdated,
      canonicalDetailSweepMessagesRechecked: counters.canonicalDetailSweepMessagesRechecked,
      canonicalDetailSweepConversationIds: counters.canonicalDetailSweepConversationIds,
      classificationProcessed: counters.classificationProcessed,
      classificationSucceeded: counters.classificationSucceeded,
      classificationFailed: counters.classificationFailed,
      classificationSkipped: counters.classificationSkipped,
      errors: counters.errors,
      warningsCount: Array.isArray(counters.warnings) ? counters.warnings.length : undefined,
    },
    backfillProgress: payload?.backfillProgress,
    safety: payload?.safety,
  });
}

export function summarizeClassificationPayload(payload = {}) {
  return redact({
    ok: payload?.ok,
    error: payload?.error,
    phase: payload?.phase,
    mode: payload?.mode,
    run_id: payload?.run_id || payload?.runId,
    status: payload?.status,
    force: payload?.force,
    run_mode: payload?.run_mode,
    requested: payload?.requested,
    processed: payload?.processed,
    attempted: payload?.attempted,
    succeeded: payload?.succeeded,
    failed: payload?.failed,
    skipped: payload?.skipped,
    candidates_examined: payload?.candidates_examined,
    unclassified_before: payload?.unclassified_before,
    unclassified_after: payload?.unclassified_after,
    remaining_unclassified: payload?.remaining_unclassified,
    queue_source: payload?.queue_source,
    canonical_queue: payload?.canonical_queue,
    safety: payload?.safety,
  });
}

export function summarizeMessages(rows = []) {
  const messages = Array.isArray(rows) ? rows : [];
  const readStateKey = (message = {}) => {
    const rawReadStatus = message.read_status == null
      ? "null"
      : String(message.read_status).trim().toLowerCase();
    const rawIsRead = typeof message.is_read === "boolean"
      ? String(message.is_read)
      : "null";
    return `${rawReadStatus}:${rawIsRead}`;
  };
  const readStateCounts = messages.reduce((counts, message) => {
    const key = readStateKey(message);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  return {
    count: messages.length,
    firstCreatedAt: messages[0]?.created_at_ebay || messages[0]?.created_at || null,
    lastCreatedAt: messages.at(-1)?.created_at_ebay || messages.at(-1)?.created_at || null,
    firstMessageId: messages[0]?.ebay_message_id || null,
    lastMessageId: messages.at(-1)?.ebay_message_id || null,
    firstReadState: messages[0] ? readStateKey(messages[0]) : null,
    lastReadState: messages.at(-1) ? readStateKey(messages.at(-1)) : null,
    readStateCounts,
    readStateSignature: messages
      .slice(-20)
      .map((message) => `${message.ebay_message_id || message.id || "unknown"}:${readStateKey(message)}`),
  };
}
