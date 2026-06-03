import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { linkEbayConversationContext } from "../_shared/ebay-conversation-context.ts";

type ServiceClient = ReturnType<typeof createClient>;
type JsonRecord = Record<string, unknown>;
type ConversationType = "FROM_MEMBERS" | "FROM_EBAY";
type MessageDirection = "inbound" | "outbound" | "platform" | "unknown";
type DirectionConfidence = "strong" | "medium" | "weak" | "unknown";
type ClassificationMode = "none" | "classify_new" | "reclassify_all";

type Operator = {
  actorType: "service_role" | "admin";
  userId: string | null;
  email: string | null;
};

type SyncInput = {
  mode: "sync";
  runType: "manual" | "scheduled" | "backfill" | "incremental" | "replay";
  conversationTypes: ConversationType[];
  conversationPageLimit: number;
  messagePageLimit: number;
  maxConversationPages: number | null;
  maxDetailPagesPerConversation: number;
  startOffset: number;
  startTime: string | null;
  endTime: string | null;
  otherPartyUsername: string | null;
  referenceId: string | null;
  conversationId: string | null;
  classificationMode: ClassificationMode;
  resumeFromCheckpoint: boolean;
  resetCheckpoint: boolean;
  checkpointScope: string;
  rateLimitPauseMs: number;
  suppressConversationActivityEvents: boolean;
};

type EbayAccount = {
  id: string;
  seller_username: string | null;
  account_key: string;
  environment: string;
};

type Counters = {
  pagesFetched: number;
  pagesSucceeded: number;
  pagesFailed: number;
  detailPagesFetched: number;
  conversationIds: string[];
  conversationsSeen: number;
  conversationsSucceeded: number;
  conversationsSkipped: number;
  conversationsInserted: number;
  conversationsUpdated: number;
  messagesSeen: number;
  messagesInserted: number;
  messagesUpdated: number;
  mediaSeen: number;
  classificationProcessed: number;
  classificationSucceeded: number;
  classificationFailed: number;
  classificationSkipped: number;
  errors: number;
  warnings: JsonRecord[];
  totalsByConversationType: Record<string, number | null>;
};

const DEFAULT_MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
const SUPPORTED_CONVERSATION_TYPES = ["FROM_MEMBERS", "FROM_EBAY"] as const;
const DEFAULT_CONVERSATION_LIMIT = 25;
const DEFAULT_MESSAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 50;
const DEFAULT_MAX_CONVERSATION_PAGES = 1;
const MAX_CONVERSATION_PAGES = 20;
const MAX_BACKFILL_CONVERSATION_PAGES = 100000;
const DEFAULT_MAX_DETAIL_PAGES = 20;
const MAX_DETAIL_PAGES = 50;
const BODY_PREVIEW_MAX = 240;
const DEFAULT_BACKFILL_CHECKPOINT_SCOPE = "commerce_message_archive";
const DEFAULT_BACKFILL_RATE_LIMIT_PAUSE_MS = 100;
const MAX_RATE_LIMIT_PAUSE_MS = 5000;
const EBAY_GET_MAX_ATTEMPTS = 4;
const TRANSIENT_EBAY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class SyncError extends Error {
  code: string;
  status: number;
  phase: string;
  details: JsonRecord;

  constructor(code: string, options: { status?: number; phase?: string; message?: string; details?: JsonRecord } = {}) {
    super(options.message || code);
    this.name = "SyncError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "sync";
    this.details = options.details || {};
  }
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new SyncError("configuration_error", { status: 500, phase: "configuration" });
  return value;
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient): Promise<Operator> {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new SyncError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new SyncError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new SyncError("configuration_error", { status: 500, phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new SyncError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

function stringOrNull(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function boundedOptionalInteger(value: unknown, fallback: number | null, min: number, max: number) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function booleanValue(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function conversationTypesFrom(value: unknown, fallback: ConversationType[] = ["FROM_MEMBERS"]): ConversationType[] {
  const raw = Array.isArray(value) ? value : stringOrNull(value) ? [value] : fallback;
  const normalized = raw.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!normalized.length) return fallback;
  const invalid = normalized.find((entry) => !SUPPORTED_CONVERSATION_TYPES.includes(entry as ConversationType));
  if (invalid) throw new SyncError("invalid_conversation_type", { status: 400, phase: "input" });
  return [...new Set(normalized)] as ConversationType[];
}

function classificationModeFrom(value: unknown): ClassificationMode {
  const normalized = String(value || "none").trim().toLowerCase();
  if (["none", "backfill_only", "backfill-only", "off"].includes(normalized)) return "none";
  if (["classify_new", "classify-new", "new", "backfill_classify_new", "backfill+classify_new"].includes(normalized)) {
    return "classify_new";
  }
  if (["reclassify_all", "reclassify-all", "force", "all", "backfill_reclassify_all"].includes(normalized)) {
    return "reclassify_all";
  }
  throw new SyncError("invalid_classification_mode", { status: 400, phase: "input" });
}

function assertAlignedOffset(offset: number, pageLimit: number) {
  if (offset % pageLimit !== 0) {
    throw new SyncError("invalid_offset_alignment", {
      status: 400,
      phase: "input",
      message: `startOffset must be a multiple of conversationPageLimit (${pageLimit}).`,
    });
  }
}

async function parseInput(req: Request): Promise<SyncInput> {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const getValue = (name: string) => body?.[name] ?? url.searchParams.get(name);
  const mode = String(getValue("mode") || "sync").trim();
  if (mode !== "sync") throw new SyncError("invalid_mode", { status: 400, phase: "input" });

  const runType = String(getValue("runType") || "manual").trim();
  if (!["manual", "scheduled", "backfill", "incremental", "replay"].includes(runType)) {
    throw new SyncError("invalid_run_type", { status: 400, phase: "input" });
  }
  const isBackfill = runType === "backfill";

  const conversationPageLimit = boundedInteger(getValue("conversationPageLimit") ?? getValue("limit"), DEFAULT_CONVERSATION_LIMIT, 1, MAX_PAGE_LIMIT);
  const messagePageLimit = boundedInteger(getValue("messagePageLimit"), DEFAULT_MESSAGE_LIMIT, 1, MAX_PAGE_LIMIT);
  const startOffset = boundedInteger(getValue("startOffset") ?? getValue("offset"), 0, 0, 10000000);
  assertAlignedOffset(startOffset, conversationPageLimit);

  const conversationId = stringOrNull(getValue("conversationId"));
  const singleType = stringOrNull(getValue("conversationType"));
  const explicitConversationTypes = getValue("conversationTypes") ?? singleType;
  const conversationTypes = conversationId && !explicitConversationTypes
    ? [...SUPPORTED_CONVERSATION_TYPES]
    : conversationTypesFrom(explicitConversationTypes, isBackfill ? [...SUPPORTED_CONVERSATION_TYPES] : ["FROM_MEMBERS"]);
  const isBatchOperation = !conversationId;
  const maxConversationPages = conversationId
    ? 0
    : isBackfill
    ? boundedOptionalInteger(getValue("maxConversationPages"), null, 1, MAX_BACKFILL_CONVERSATION_PAGES)
    : boundedInteger(getValue("maxConversationPages"), DEFAULT_MAX_CONVERSATION_PAGES, 1, MAX_CONVERSATION_PAGES);
  const classificationMode = classificationModeFrom(getValue("classificationMode") ?? getValue("backfillClassificationMode"));

  return {
    mode: "sync",
    runType: runType as SyncInput["runType"],
    conversationTypes,
    conversationPageLimit,
    messagePageLimit,
    maxConversationPages,
    maxDetailPagesPerConversation: boundedInteger(getValue("maxDetailPagesPerConversation"), DEFAULT_MAX_DETAIL_PAGES, 1, MAX_DETAIL_PAGES),
    startOffset,
    startTime: stringOrNull(getValue("startTime")),
    endTime: stringOrNull(getValue("endTime")),
    otherPartyUsername: stringOrNull(getValue("otherPartyUsername")),
    referenceId: stringOrNull(getValue("referenceId")),
    conversationId,
    classificationMode,
    resumeFromCheckpoint: booleanValue(getValue("resumeFromCheckpoint"), isBackfill),
    resetCheckpoint: booleanValue(getValue("resetCheckpoint"), false),
    checkpointScope: stringOrNull(getValue("checkpointScope")) || DEFAULT_BACKFILL_CHECKPOINT_SCOPE,
    rateLimitPauseMs: boundedInteger(
      getValue("rateLimitPauseMs"),
      isBackfill ? DEFAULT_BACKFILL_RATE_LIMIT_PAUSE_MS : 0,
      0,
      MAX_RATE_LIMIT_PAUSE_MS,
    ),
    suppressConversationActivityEvents: booleanValue(getValue("suppressConversationActivityEvents"), isBatchOperation),
  };
}

function text(value: unknown) {
  return String(value || "").trim();
}

function firstText(...values: unknown[]) {
  return values.map((value) => text(value)).find(Boolean) || "";
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function firstArray(...values: unknown[]) {
  return values.find((value) => Array.isArray(value)) as unknown[] | undefined;
}

function numberOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readStatusToBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["read", "true", "1"].includes(normalized)) return true;
  if (["unread", "false", "0"].includes(normalized)) return false;
  return null;
}

function isoOrNull(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function preview(value: unknown, maxLength = BODY_PREVIEW_MAX) {
  const cleaned = text(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

async function sha256Hex(value: string) {
  if (!value) return null;
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripLargeFields(value: unknown): JsonRecord {
  const source = recordOrEmpty(value);
  const cleaned: JsonRecord = {};
  for (const [key, entry] of Object.entries(source)) {
    if (["messageBody", "body", "text", "messages", "messageMedia", "media", "attachments"].includes(key)) continue;
    if (key === "latestMessage") {
      const latest = recordOrEmpty(entry);
      cleaned.latestMessage = Object.fromEntries(
        Object.entries(latest).filter(([latestKey]) => !["messageBody", "body", "text"].includes(latestKey)),
      );
      continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}

function safeMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return text(payload).slice(0, 500);
  const record = payload as JsonRecord;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const firstError = errors.find((entry) => entry && typeof entry === "object") as JsonRecord | undefined;
  const parts = [
    record.error,
    record.error_description,
    record.message,
    firstError?.message,
    firstError?.longMessage,
    firstError?.errorId ? `errorId:${firstError.errorId}` : "",
    firstError?.domain ? `domain:${firstError.domain}` : "",
    firstError?.category ? `category:${firstError.category}` : "",
  ].map((value) => text(value)).filter(Boolean);
  return (parts.join(" | ") || "Unknown eBay error").slice(0, 500);
}

async function parseResponse(res: Response) {
  const bodyText = await res.text();
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    return { raw: bodyText.slice(0, 500) };
  }
}

function sleep(ms: number) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value: string | null) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

function jsonForLog(value: unknown, maxLength = 4000): JsonRecord | string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, maxLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) return value as JsonRecord;
    return { truncated_json: serialized.slice(0, maxLength), truncated: true };
  } catch {
    return text(value).slice(0, maxLength);
  }
}

function ebayRequestDiagnostic(path: string, status: number, payload: unknown, attempts: number): JsonRecord {
  const url = new URL(path, ebayApiBase());
  return {
    method: "GET",
    endpoint: `${url.origin}${url.pathname}`,
    path,
    parameters: Object.fromEntries(url.searchParams.entries()),
    http_status: status,
    attempts,
    ebay_error_payload: jsonForLog(payload),
  };
}

function ebayEnvironment() {
  const value = (Deno.env.get("EBAY_ENV") || "production").trim().toLowerCase();
  if (value === "sandbox") return "sandbox";
  if (value === "production") return "production";
  return "unknown";
}

function ebayApiBase() {
  return ebayEnvironment() === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

async function refreshEbayToken(): Promise<string> {
  const clientId = optionalEnv("EBAY_CLIENT_ID", "EBAY_APP_ID");
  const clientSecret = optionalEnv("EBAY_CLIENT_SECRET", "EBAY_CERT_ID");
  const refreshToken = optionalEnv("EBAY_REFRESH_TOKEN");
  const scope = (Deno.env.get("EBAY_MESSAGE_SCOPE") || DEFAULT_MESSAGE_SCOPE).trim() || DEFAULT_MESSAGE_SCOPE;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new SyncError("missing_ebay_oauth_secret", { status: 500, phase: "oauth" });
  }

  const res = await fetch(`${ebayApiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope,
    }),
  });

  const payload = await parseResponse(res);
  if (!res.ok) {
    throw new SyncError("ebay_oauth_refresh_failed", {
      status: 502,
      phase: "oauth",
      message: safeMessage(payload),
    });
  }

  const token = text((payload as JsonRecord).access_token);
  if (!token) throw new SyncError("ebay_oauth_missing_access_token", { status: 502, phase: "oauth" });
  return token;
}

async function ebayGet(token: string, path: string): Promise<JsonRecord> {
  let lastPayload: unknown = {};
  let lastStatus = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= EBAY_GET_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const res = await fetch(`${ebayApiBase()}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
      },
    });
    const payload = await parseResponse(res);
    if (res.ok) return payload as JsonRecord;

    lastPayload = payload;
    lastStatus = res.status;
    if (!TRANSIENT_EBAY_STATUSES.has(res.status) || attempt >= EBAY_GET_MAX_ATTEMPTS) break;
    const waitMs = retryAfterMs(res.headers.get("Retry-After")) ?? Math.min(250 * 2 ** (attempt - 1), 2000);
    await sleep(waitMs);
  }

  throw new SyncError("ebay_api_get_failed", {
    status: 502,
    phase: "ebay_api",
    message: `GET ${path} failed (${lastStatus}): ${safeMessage(lastPayload)}`,
    details: {
      ebay_api: ebayRequestDiagnostic(path, lastStatus, lastPayload, attempts),
    },
  });
}

function otherPartyUsername(conversation: JsonRecord) {
  return firstText(
    conversation.otherPartyUsername,
    recordOrEmpty(conversation.otherParty).username,
    recordOrEmpty(conversation.participant).username,
  ) || null;
}

function latestMessage(conversation: JsonRecord) {
  return recordOrEmpty(conversation.latestMessage);
}

function referenceId(conversation: JsonRecord) {
  const listingReference = recordOrEmpty(conversation.listingReference);
  const reference = recordOrEmpty(conversation.reference);
  return firstText(
    conversation.referenceId,
    conversation.listingId,
    conversation.itemId,
    listingReference.referenceId,
    listingReference.listingId,
    listingReference.itemId,
    reference.referenceId,
    reference.id,
  ) || null;
}

function referenceType(conversation: JsonRecord) {
  const listingReference = recordOrEmpty(conversation.listingReference);
  const reference = recordOrEmpty(conversation.reference);
  return firstText(
    conversation.referenceType,
    listingReference.referenceType,
    listingReference.type,
    reference.referenceType,
    reference.type,
  ) || null;
}

function conversationPath(input: SyncInput, conversationType: ConversationType, offset: number) {
  const params = new URLSearchParams({
    conversation_type: conversationType,
    limit: String(input.conversationPageLimit),
    offset: String(offset),
  });

  if (input.otherPartyUsername) params.set("other_party_username", input.otherPartyUsername);
  if (input.referenceId) {
    params.set("reference_id", input.referenceId);
    params.set("reference_type", "LISTING");
  }
  if (conversationType === "FROM_MEMBERS") {
    if (input.startTime) params.set("start_time", input.startTime);
    if (input.endTime) params.set("end_time", input.endTime);
  }

  return `/commerce/message/v1/conversation?${params.toString()}`;
}

function conversationDetailPath(conversationId: string, conversationType: ConversationType, pageLimit: number, offset: number) {
  const params = new URLSearchParams({
    conversation_type: conversationType,
    limit: String(pageLimit),
    offset: String(offset),
  });
  return `/commerce/message/v1/conversation/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

function inferDirection(options: {
  conversationType: ConversationType;
  senderUsername: string | null;
  recipientUsername: string | null;
  otherPartyUsername: string | null;
  sellerUsername: string | null;
}): { direction: MessageDirection; confidence: DirectionConfidence; reason: string } {
  if (options.conversationType === "FROM_EBAY") {
    return { direction: "platform", confidence: "medium", reason: "Conversation type is FROM_EBAY." };
  }

  const sender = options.senderUsername?.toLowerCase() || "";
  const recipient = options.recipientUsername?.toLowerCase() || "";
  const seller = options.sellerUsername?.toLowerCase() || "";
  const otherParty = options.otherPartyUsername?.toLowerCase() || "";

  if (seller && sender === seller) {
    return { direction: "outbound", confidence: "strong", reason: "senderUsername matches configured seller username." };
  }
  if (seller && recipient === seller) {
    return { direction: "inbound", confidence: "strong", reason: "recipientUsername matches configured seller username." };
  }
  if (otherParty && sender === otherParty) {
    return { direction: "inbound", confidence: "strong", reason: "senderUsername matches conversation otherPartyUsername." };
  }
  if (otherParty && recipient === otherParty) {
    return { direction: "outbound", confidence: "strong", reason: "recipientUsername matches conversation otherPartyUsername." };
  }
  if (sender && recipient) {
    return { direction: "unknown", confidence: "weak", reason: "senderUsername and recipientUsername are present, but seller/other-party identity did not match." };
  }
  return { direction: "unknown", confidence: "unknown", reason: "Sender or recipient username is missing." };
}

async function upsertSellerAccount(supabase: ServiceClient): Promise<EbayAccount> {
  const environment = ebayEnvironment();
  const sellerUsername = stringOrNull(optionalEnv("EBAY_SELLER_USERNAME", "EBAY_ACCOUNT_USERNAME"));
  const accountKey = optionalEnv("EBAY_SELLER_ACCOUNT_KEY") || `${environment}:${sellerUsername || "default"}`;
  const marketplaceId = optionalEnv("EBAY_MARKETPLACE_ID") || "EBAY_US";

  const { data, error } = await supabase
    .from("ebay_seller_accounts")
    .upsert({
      account_key: accountKey,
      seller_username: sellerUsername,
      marketplace_id: marketplaceId,
      environment,
      auth_source: "supabase_secret",
      status: "active",
      metadata: {
        source: "ebay-message-sync",
        sellerUsernameConfigured: Boolean(sellerUsername),
      },
    }, { onConflict: "account_key" })
    .select("id, account_key, seller_username, environment")
    .single();

  if (error || !data?.id) throw new SyncError("seller_account_upsert_failed", { phase: "database", message: error?.message });
  return data as EbayAccount;
}

async function createRun(supabase: ServiceClient, input: SyncInput, account: EbayAccount, operator: Operator) {
  const { data, error } = await supabase
    .from("ebay_message_sync_runs")
    .insert({
      seller_account_id: account.id,
      run_type: input.runType,
      status: "running",
      conversation_type: input.conversationTypes.length === 1 ? input.conversationTypes[0] : null,
      started_by: operator.userId,
      trigger_source: operator.actorType === "service_role" ? "service_role" : "admin_edge_function",
      requested_start_time: isoOrNull(input.startTime),
      requested_end_time: isoOrNull(input.endTime),
      requested_reference_id: input.referenceId,
      requested_other_party_username: input.otherPartyUsername,
      conversation_page_limit: input.conversationPageLimit,
      message_page_limit: input.messagePageLimit,
      max_conversation_pages: input.maxConversationPages ?? 0,
      max_detail_pages_per_conversation: input.maxDetailPagesPerConversation,
      metadata: {
        conversationTypes: input.conversationTypes,
        conversationId: input.conversationId,
        startOffset: input.startOffset,
        checkpointScope: input.checkpointScope,
        resumeFromCheckpoint: input.resumeFromCheckpoint,
        resetCheckpoint: input.resetCheckpoint,
        classificationMode: input.classificationMode,
        maxConversationPages: input.maxConversationPages,
        rateLimitPauseMs: input.rateLimitPauseMs,
        suppress_conversation_activity_events: input.suppressConversationActivityEvents,
        readOnly: true,
        sendsEnabled: false,
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) throw new SyncError("sync_run_insert_failed", { phase: "database", message: error?.message });
  return data.id as string;
}

async function existingConversationsById(supabase: ServiceClient, accountId: string, conversationType: ConversationType, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; ebay_conversation_id: string; unread_count: number }>();
  const { data, error } = await supabase
    .from("ebay_conversations")
    .select("id, ebay_conversation_id, unread_count")
    .eq("seller_account_id", accountId)
    .eq("conversation_type", conversationType)
    .in("ebay_conversation_id", ids);
  if (error) throw new SyncError("conversation_existing_lookup_failed", { phase: "database", message: error.message });
  return new Map((data || [])
    .map((row: any) => [text(row.ebay_conversation_id), {
      id: text(row.id),
      ebay_conversation_id: text(row.ebay_conversation_id),
      unread_count: Number(row.unread_count || 0),
    }] as const)
    .filter(([id]) => Boolean(id)));
}

async function upsertConversation(
  supabase: ServiceClient,
  account: EbayAccount,
  runId: string,
  conversationType: ConversationType,
  payload: JsonRecord,
  existing: { unread_count: number } | null = null,
) {
  const ebayConversationId = firstText(payload.conversationId, payload.id);
  if (!ebayConversationId) throw new SyncError("conversation_missing_id", { phase: "payload" });

  const latest = latestMessage(payload);
  const row = {
    seller_account_id: account.id,
    ebay_conversation_id: ebayConversationId,
    conversation_type: conversationType,
    conversation_status: firstText(payload.conversationStatus, payload.status) || null,
    conversation_title: firstText(payload.conversationTitle, payload.title) || null,
    other_party_username: otherPartyUsername(payload),
    reference_id: referenceId(payload),
    reference_type: referenceType(payload),
    unread_count: existing ? Math.max(Number(existing.unread_count || 0), 0) : numberOrNull(payload.unreadCount) ?? 0,
    latest_message_id: firstText(latest.messageId, latest.id) || null,
    latest_message_created_at: isoOrNull(latest.createdDate) || isoOrNull(payload.createdDate),
    latest_message_preview: preview(firstText(latest.messageBody, latest.body, latest.text)) || null,
    last_synced_at: new Date().toISOString(),
    last_sync_run_id: runId,
    last_seen_at: new Date().toISOString(),
    raw_summary: stripLargeFields(payload),
  };

  const { data, error } = await supabase
    .from("ebay_conversations")
    .upsert(row, { onConflict: "seller_account_id,conversation_type,ebay_conversation_id" })
    .select("id, reference_id, reference_type, other_party_username")
    .single();

  if (error || !data?.id) throw new SyncError("conversation_upsert_failed", { phase: "database", message: error?.message });
  return data as { id: string; reference_id: string | null; reference_type: string | null; other_party_username: string | null };
}

async function upsertConversationLinks(
  supabase: ServiceClient,
  account: EbayAccount,
  conversation: { id: string; reference_id: string | null; reference_type: string | null; other_party_username: string | null },
) {
  const rows = [];
  if (conversation.reference_id) {
    rows.push({
      conversation_id: conversation.id,
      seller_account_id: account.id,
      link_type: "listing_reference",
      link_key: `reference:${conversation.reference_type || "UNKNOWN"}:${conversation.reference_id}`,
      reference_id: conversation.reference_id,
      reference_type: conversation.reference_type,
      matched_value: conversation.reference_id,
      match_method: "direct_api_field",
      confidence: 0.9,
      status: "confirmed",
      metadata: { source: "ebay_message_payload" },
    });
  }
  if (conversation.other_party_username) {
    rows.push({
      conversation_id: conversation.id,
      seller_account_id: account.id,
      link_type: "buyer_username",
      link_key: `username:${conversation.other_party_username.toLowerCase()}`,
      buyer_username: conversation.other_party_username,
      matched_value: conversation.other_party_username,
      match_method: "direct_api_field",
      confidence: 0.85,
      status: "confirmed",
      metadata: { source: "ebay_message_payload" },
    });
  }
  if (!rows.length) return;
  const { error } = await supabase
    .from("ebay_conversation_links")
    .upsert(rows, { onConflict: "conversation_id,link_type,link_key" });
  if (error) throw new SyncError("conversation_link_upsert_failed", { phase: "database", message: error.message });
}

async function existingMessagesById(
  supabase: ServiceClient,
  accountId: string,
  conversationType: ConversationType,
  ebayConversationId: string,
  messageIds: string[],
) {
  if (!messageIds.length) return new Map<string, { ebay_message_id: string; read_status: string | null; is_read: boolean | null }>();
  const { data, error } = await supabase
    .from("ebay_conversation_messages")
    .select("ebay_message_id, read_status, is_read")
    .eq("seller_account_id", accountId)
    .eq("conversation_type", conversationType)
    .eq("ebay_conversation_id", ebayConversationId)
    .in("ebay_message_id", messageIds);
  if (error) throw new SyncError("message_existing_lookup_failed", { phase: "database", message: error.message });
  return new Map((data || [])
    .map((row: any) => [text(row.ebay_message_id), {
      ebay_message_id: text(row.ebay_message_id),
      read_status: row.read_status ?? null,
      is_read: typeof row.is_read === "boolean" ? row.is_read : null,
    }] as const)
    .filter(([id]) => Boolean(id)));
}

async function upsertMessages(options: {
  supabase: ServiceClient;
  account: EbayAccount;
  runId: string;
  conversationRowId: string;
  ebayConversationId: string;
  conversationType: ConversationType;
  otherParty: string | null;
  messages: JsonRecord[];
  counters: Counters;
}) {
  const messageIds = options.messages.map((message) => firstText(message.messageId, message.id)).filter(Boolean);
  const existing = await existingMessagesById(
    options.supabase,
    options.account.id,
    options.conversationType,
    options.ebayConversationId,
    messageIds,
  );

  const rows = [];
  for (const message of options.messages) {
    const ebayMessageId = firstText(message.messageId, message.id);
    if (!ebayMessageId) {
      options.counters.warnings.push({ code: "message_missing_id", conversationId: options.ebayConversationId });
      continue;
    }
    const body = firstText(message.messageBody, message.body, message.text);
    const media = firstArray(message.messageMedia, message.media, message.attachments) || [];
    const senderUsername = firstText(message.senderUsername, recordOrEmpty(message.sender).username) || null;
    const recipientUsername = firstText(message.recipientUsername, recordOrEmpty(message.recipient).username) || null;
    const direction = inferDirection({
      conversationType: options.conversationType,
      senderUsername,
      recipientUsername,
      otherPartyUsername: options.otherParty,
      sellerUsername: options.account.seller_username,
    });
    const existingMessage = existing.get(ebayMessageId) || null;
    const apiReadStatus = text(message.readStatus) || null;
    const apiIsRead = readStatusToBoolean(message.readStatus);

    if (existingMessage) options.counters.messagesUpdated += 1;
    else options.counters.messagesInserted += 1;
    options.counters.mediaSeen += media.length;

    rows.push({
      conversation_id: options.conversationRowId,
      seller_account_id: options.account.id,
      ebay_conversation_id: options.ebayConversationId,
      conversation_type: options.conversationType,
      ebay_message_id: ebayMessageId,
      sender_username: senderUsername,
      recipient_username: recipientUsername,
      direction: direction.direction,
      direction_confidence: direction.confidence,
      direction_reason: direction.reason,
      subject: firstText(message.subject, message.title) || null,
      message_body: body || null,
      message_body_sha256: await sha256Hex(body),
      message_body_preview: preview(body) || null,
      read_status: existingMessage ? existingMessage.read_status : apiReadStatus,
      is_read: existingMessage ? existingMessage.is_read : apiIsRead,
      message_status: firstText(message.messageStatus, message.status) || null,
      created_at_ebay: isoOrNull(message.createdDate) || isoOrNull(message.creationDate) || isoOrNull(message.sentDate),
      message_media: media,
      has_media: media.length > 0,
      media_count: media.length,
      raw_message_metadata: stripLargeFields(message),
      last_sync_run_id: options.runId,
      last_seen_at: new Date().toISOString(),
    });
  }

  if (!rows.length) return [];
  const { data, error } = await options.supabase
    .from("ebay_conversation_messages")
    .upsert(rows, { onConflict: "seller_account_id,conversation_type,ebay_conversation_id,ebay_message_id" })
    .select("created_at_ebay, ebay_message_id, message_body_preview, sender_username");
  if (error) throw new SyncError("message_upsert_failed", { phase: "database", message: error.message });
  return data || [];
}

async function updateConversationFromDetail(options: {
  supabase: ServiceClient;
  conversationRowId: string;
  runId: string;
  detailPayload: JsonRecord;
  messages: any[];
  total: number | null;
}) {
  const timestamps = options.messages
    .map((message) => isoOrNull(message.created_at_ebay))
    .filter(Boolean)
    .sort() as string[];
  const latest = [...options.messages]
    .filter((message) => message.created_at_ebay)
    .sort((a, b) => String(b.created_at_ebay).localeCompare(String(a.created_at_ebay)))[0];

  const update = {
    conversation_status: firstText(options.detailPayload.conversationStatus, options.detailPayload.status) || undefined,
    conversation_title: firstText(options.detailPayload.conversationTitle, options.detailPayload.title) || undefined,
    other_party_username: otherPartyUsername(options.detailPayload) || undefined,
    reference_id: referenceId(options.detailPayload) || undefined,
    reference_type: referenceType(options.detailPayload) || undefined,
    first_message_created_at: timestamps[0] || undefined,
    last_message_created_at: timestamps[timestamps.length - 1] || undefined,
    latest_message_id: latest?.ebay_message_id || undefined,
    latest_message_created_at: latest?.created_at_ebay || undefined,
    latest_message_preview: latest?.message_body_preview || undefined,
    message_count: options.total ?? options.messages.length,
    last_detail_synced_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    last_sync_run_id: options.runId,
    last_seen_at: new Date().toISOString(),
    raw_detail_metadata: stripLargeFields(options.detailPayload),
  };

  Object.keys(update).forEach((key) => {
    if ((update as JsonRecord)[key] === undefined) delete (update as JsonRecord)[key];
  });

  const { error } = await options.supabase
    .from("ebay_conversations")
    .update(update)
    .eq("id", options.conversationRowId);
  if (error) throw new SyncError("conversation_detail_update_failed", { phase: "database", message: error.message });
}

async function syncConversationDetail(options: {
  supabase: ServiceClient;
  token: string;
  account: EbayAccount;
  runId: string;
  input: SyncInput;
  conversationType: ConversationType;
  conversationPayload: JsonRecord;
  conversationRow: { id: string; other_party_username: string | null };
  counters: Counters;
}) {
  const ebayConversationId = firstText(options.conversationPayload.conversationId, options.conversationPayload.id);
  let offset = 0;
  let total: number | null = null;
  const persistedMessages: any[] = [];

  for (let page = 0; page < options.input.maxDetailPagesPerConversation; page += 1) {
    const detail = await ebayGet(
      options.token,
      conversationDetailPath(ebayConversationId, options.conversationType, options.input.messagePageLimit, offset),
    );
    options.counters.detailPagesFetched += 1;
    const messages = (Array.isArray(detail.messages) ? detail.messages : []) as JsonRecord[];
    total = numberOrNull(detail.total);
    options.counters.messagesSeen += messages.length;
    const detailOtherParty = otherPartyUsername(detail) || options.conversationRow.other_party_username || otherPartyUsername(options.conversationPayload);
    const rows = await upsertMessages({
      supabase: options.supabase,
      account: options.account,
      runId: options.runId,
      conversationRowId: options.conversationRow.id,
      ebayConversationId,
      conversationType: options.conversationType,
      otherParty: detailOtherParty,
      messages,
      counters: options.counters,
    });
    persistedMessages.push(...rows);

    await updateConversationFromDetail({
      supabase: options.supabase,
      conversationRowId: options.conversationRow.id,
      runId: options.runId,
      detailPayload: detail,
      messages: persistedMessages,
      total,
    });
    await upsertConversationLinks(options.supabase, options.account, {
      id: options.conversationRow.id,
      reference_id: referenceId(detail),
      reference_type: referenceType(detail),
      other_party_username: detailOtherParty,
    });

    if (!messages.length || messages.length < options.input.messagePageLimit) break;
    if (typeof total === "number" && offset + options.input.messagePageLimit >= total) break;
    offset += options.input.messagePageLimit;
    await sleep(options.input.rateLimitPauseMs);
  }
}

function latestConversationTimestamp(conversation: JsonRecord) {
  const latest = latestMessage(conversation);
  return isoOrNull(latest.createdDate) ||
    isoOrNull(conversation.lastMessageDate) ||
    isoOrNull(conversation.updatedDate) ||
    isoOrNull(conversation.createdDate);
}

function newestTimestamp(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function syncRunProgressMetadata(input: SyncInput, counters: Counters, extra: JsonRecord = {}) {
  return {
    ...extra,
    conversationTypes: input.conversationTypes,
    startOffset: input.startOffset,
    checkpointScope: input.checkpointScope,
    resumeFromCheckpoint: input.resumeFromCheckpoint,
    resetCheckpoint: input.resetCheckpoint,
    classificationMode: input.classificationMode,
    maxConversationPages: input.maxConversationPages,
    rateLimitPauseMs: input.rateLimitPauseMs,
    conversationIds: counters.conversationIds,
    pagesSucceeded: counters.pagesSucceeded,
    pagesFailed: counters.pagesFailed,
    conversationsSucceeded: counters.conversationsSucceeded,
    conversationsSkipped: counters.conversationsSkipped,
    classificationProcessed: counters.classificationProcessed,
    classificationSucceeded: counters.classificationSucceeded,
    classificationFailed: counters.classificationFailed,
    classificationSkipped: counters.classificationSkipped,
    totalsByConversationType: counters.totalsByConversationType,
    suppress_conversation_activity_events: input.suppressConversationActivityEvents,
    readOnly: true,
    sendsEnabled: false,
    ebayMutationsPerformed: false,
  };
}

async function updateRunProgress(
  supabase: ServiceClient,
  runId: string,
  counters: Counters,
  metadata: JsonRecord,
) {
  const { error } = await supabase
    .from("ebay_message_sync_runs")
    .update({
      pages_fetched: counters.pagesFetched,
      detail_pages_fetched: counters.detailPagesFetched,
      conversations_seen: counters.conversationsSeen,
      conversations_inserted: counters.conversationsInserted,
      conversations_updated: counters.conversationsUpdated,
      messages_seen: counters.messagesSeen,
      messages_inserted: counters.messagesInserted,
      messages_updated: counters.messagesUpdated,
      media_seen: counters.mediaSeen,
      errors: counters.errors,
      warnings: counters.warnings,
      metadata,
    })
    .eq("id", runId);
  if (error) throw new SyncError("sync_run_progress_update_failed", { phase: "database", message: error.message });
}

async function beginCheckpoint(options: {
  supabase: ServiceClient;
  account: EbayAccount;
  runId: string;
  input: SyncInput;
  conversationType: ConversationType;
}) {
  const { data: existing, error: lookupError } = await options.supabase
    .from("ebay_message_sync_checkpoints")
    .select("id, status, next_offset, pages_processed, conversations_processed, messages_processed, last_conversation_timestamp, metadata")
    .eq("seller_account_id", options.account.id)
    .eq("checkpoint_scope", options.input.checkpointScope)
    .eq("conversation_type", options.conversationType)
    .maybeSingle();
  if (lookupError) throw new SyncError("sync_checkpoint_lookup_failed", { phase: "database", message: lookupError.message });

  const resumeOffset = options.input.startOffset > 0
    ? options.input.startOffset
    : options.input.resetCheckpoint
    ? 0
    : options.input.resumeFromCheckpoint
    ? Number(existing?.next_offset || 0)
    : 0;
  assertAlignedOffset(resumeOffset, options.input.conversationPageLimit);

  const { error } = await options.supabase
    .from("ebay_message_sync_checkpoints")
    .upsert({
      seller_account_id: options.account.id,
      checkpoint_scope: options.input.checkpointScope,
      conversation_type: options.conversationType,
      status: "running",
      current_run_id: options.runId,
      last_run_id: options.runId,
      next_offset: resumeOffset,
      pages_processed: options.input.resetCheckpoint ? 0 : Number(existing?.pages_processed || 0),
      conversations_processed: options.input.resetCheckpoint ? 0 : Number(existing?.conversations_processed || 0),
      messages_processed: options.input.resetCheckpoint ? 0 : Number(existing?.messages_processed || 0),
      last_error_code: null,
      last_error_message: null,
      metadata: {
        ...(recordOrEmpty(existing?.metadata)),
        run_id: options.runId,
        started_at: new Date().toISOString(),
        resume_offset: resumeOffset,
        reset_checkpoint: options.input.resetCheckpoint,
        max_conversation_pages: options.input.maxConversationPages,
        page_limit: options.input.conversationPageLimit,
        message_page_limit: options.input.messagePageLimit,
        classification_mode: options.input.classificationMode,
      },
    }, { onConflict: "seller_account_id,checkpoint_scope,conversation_type" });
  if (error) throw new SyncError("sync_checkpoint_begin_failed", { phase: "database", message: error.message });

  return {
    resumeOffset,
    lastConversationTimestamp: isoOrNull(existing?.last_conversation_timestamp) || null,
  };
}

async function updateCheckpointProgress(options: {
  supabase: ServiceClient;
  account: EbayAccount;
  runId: string;
  input: SyncInput;
  conversationType: ConversationType;
  lastPageProcessed: number;
  nextOffset: number;
  totalAvailable: number | null;
  pagesProcessed: number;
  conversationsProcessed: number;
  messagesProcessed: number;
  lastConversationTimestamp: string | null;
  exhausted: boolean;
  currentRunComplete?: boolean;
  counters: Counters;
}) {
  const status = options.exhausted ? "succeeded" : options.currentRunComplete ? "idle" : "running";
  const update: JsonRecord = {
    status,
    current_run_id: options.exhausted || options.currentRunComplete ? null : options.runId,
    last_run_id: options.runId,
    last_successful_sync_at: new Date().toISOString(),
    last_page_processed: options.lastPageProcessed,
    next_offset: options.exhausted ? 0 : options.nextOffset,
    total_available: options.totalAvailable,
    pages_processed: options.pagesProcessed,
    conversations_processed: options.conversationsProcessed,
    messages_processed: options.messagesProcessed,
    last_error_code: null,
    last_error_message: null,
    metadata: {
      run_id: options.runId,
      status,
      conversation_type: options.conversationType,
      last_page_processed: options.lastPageProcessed,
      next_offset: options.exhausted ? 0 : options.nextOffset,
      total_available: options.totalAvailable,
      page_limit: options.input.conversationPageLimit,
      message_page_limit: options.input.messagePageLimit,
      exhausted: options.exhausted,
      current_run_complete: options.currentRunComplete === true,
      classification_mode: options.input.classificationMode,
      counters: {
        pages_fetched: options.counters.pagesFetched,
        detail_pages_fetched: options.counters.detailPagesFetched,
        conversations_seen: options.counters.conversationsSeen,
        messages_seen: options.counters.messagesSeen,
        messages_inserted: options.counters.messagesInserted,
        messages_updated: options.counters.messagesUpdated,
      },
      updated_at: new Date().toISOString(),
    },
  };
  if (options.exhausted && options.input.runType === "backfill") {
    update.last_full_backfill_at = new Date().toISOString();
  }
  if (options.lastConversationTimestamp) {
    update.last_conversation_timestamp = options.lastConversationTimestamp;
  }

  const { error } = await options.supabase
    .from("ebay_message_sync_checkpoints")
    .update(update)
    .eq("seller_account_id", options.account.id)
    .eq("checkpoint_scope", options.input.checkpointScope)
    .eq("conversation_type", options.conversationType);
  if (error) throw new SyncError("sync_checkpoint_progress_failed", { phase: "database", message: error.message });
}

async function failRunningCheckpoints(
  supabase: ServiceClient,
  runId: string | null,
  error: unknown,
  counters?: Counters,
) {
  if (!runId) return;
  const syncError = error instanceof SyncError ? error : null;
  await supabase
    .from("ebay_message_sync_checkpoints")
    .update({
      status: "failed",
      current_run_id: null,
      last_run_id: runId,
      last_error_code: syncError?.code || "unknown_error",
      last_error_message: error instanceof Error ? error.message.slice(0, 1000) : String(error || "Unknown error").slice(0, 1000),
      metadata: {
        failed_at: new Date().toISOString(),
        run_id: runId,
        failure: failureDetails(error),
        counters: counters || {},
      },
    })
    .eq("current_run_id", runId);
}

function failureDetails(error: unknown): JsonRecord {
  const syncError = error instanceof SyncError ? error : null;
  return {
    error_code: syncError?.code || "unknown_error",
    error_phase: syncError?.phase || "unknown",
    internal_error_payload: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message.slice(0, 1000) : String(error || "Unknown error").slice(0, 1000),
      status: syncError?.status || 500,
    },
    ...(syncError?.details || {}),
  };
}

async function processConversationPage(options: {
  supabase: ServiceClient;
  token: string;
  account: EbayAccount;
  runId: string;
  input: SyncInput;
  conversationType: ConversationType;
  conversations: JsonRecord[];
  counters: Counters;
}) {
  const ids = options.conversations.map((conversation) => firstText(conversation.conversationId, conversation.id)).filter(Boolean);
  const existing = await existingConversationsById(options.supabase, options.account.id, options.conversationType, ids);
  const rowIds: string[] = [];
  let latestTimestamp: string | null = null;
  options.counters.conversationsSeen += options.conversations.length;

  for (const conversation of options.conversations) {
    const ebayConversationId = firstText(conversation.conversationId, conversation.id);
    if (!ebayConversationId) {
      options.counters.conversationsSkipped += 1;
      options.counters.warnings.push({ code: "conversation_missing_id", conversationType: options.conversationType });
      continue;
    }
    if (!options.counters.conversationIds.includes(ebayConversationId) && options.counters.conversationIds.length < 250) {
      options.counters.conversationIds.push(ebayConversationId);
    }
    const existingConversation = existing.get(ebayConversationId) || null;
    if (existingConversation) options.counters.conversationsUpdated += 1;
    else options.counters.conversationsInserted += 1;
    const conversationRow = await upsertConversation(
      options.supabase,
      options.account,
      options.runId,
      options.conversationType,
      conversation,
      existingConversation,
    );
    options.counters.conversationsSucceeded += 1;
    rowIds.push(conversationRow.id);
    latestTimestamp = newestTimestamp(latestTimestamp, latestConversationTimestamp(conversation));

    await upsertConversationLinks(options.supabase, options.account, conversationRow);
    await syncConversationDetail({
      supabase: options.supabase,
      token: options.token,
      account: options.account,
      runId: options.runId,
      input: options.input,
      conversationType: options.conversationType,
      conversationPayload: conversation,
      conversationRow,
      counters: options.counters,
    });
    const linkResult = await linkEbayConversationContext(options.supabase, conversationRow.id);
    if (linkResult.warnings.length) {
      options.counters.warnings.push({
        code: "conversation_context_link_warnings",
        conversationId: ebayConversationId,
        warnings: linkResult.warnings.slice(0, 10),
      });
    }
    await upsertConversationLinks(options.supabase, options.account, {
      id: conversationRow.id,
      reference_id: referenceId(conversation) || conversationRow.reference_id,
      reference_type: referenceType(conversation) || conversationRow.reference_type,
      other_party_username: otherPartyUsername(conversation) || conversationRow.other_party_username,
    });
    await sleep(options.input.rateLimitPauseMs);
  }

  return { rowIds, latestTimestamp };
}

async function conversationsWithAnyClassification(supabase: ServiceClient, conversationIds: string[]) {
  if (!conversationIds.length) return new Set<string>();
  const { data, error } = await supabase
    .from("ebay_conversation_classifications")
    .select("conversation_id")
    .in("conversation_id", conversationIds)
    .limit(conversationIds.length * 10);
  if (error) throw new SyncError("classification_existing_lookup_failed", { phase: "classification_lookup", message: error.message });
  return new Set((data || []).map((row: any) => text(row.conversation_id)).filter(Boolean));
}

function edgeFunctionUrl(functionName: string) {
  return `${requiredEnv("SUPABASE_URL").replace(/\/+$/, "")}/functions/v1/${functionName}`;
}

async function classifyConversationViaFunction(conversationId: string, force: boolean) {
  const res = await fetch(edgeFunctionUrl("ebay-conversation-classify"), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${requiredEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "classify_conversation",
      conversationId,
      force,
      suppressActivityEvent: true,
    }),
  });
  const payload = await parseResponse(res);
  if (!res.ok || (payload as JsonRecord).ok === false) {
    throw new SyncError("conversation_classification_failed", {
      phase: "classification",
      status: 502,
      message: safeMessage(payload),
    });
  }
  return payload as JsonRecord;
}

async function classifyProcessedConversations(options: {
  supabase: ServiceClient;
  input: SyncInput;
  conversationIds: string[];
  counters: Counters;
}) {
  const uniqueIds = [...new Set(options.conversationIds.filter(Boolean))];
  if (!uniqueIds.length || options.input.classificationMode === "none") return;

  let candidates = uniqueIds;
  if (options.input.classificationMode === "classify_new") {
    const alreadyClassified = await conversationsWithAnyClassification(options.supabase, uniqueIds);
    options.counters.classificationSkipped += alreadyClassified.size;
    candidates = uniqueIds.filter((id) => !alreadyClassified.has(id));
  }

  for (const conversationId of candidates) {
    options.counters.classificationProcessed += 1;
    try {
      await classifyConversationViaFunction(conversationId, options.input.classificationMode === "reclassify_all");
      options.counters.classificationSucceeded += 1;
    } catch (error) {
      options.counters.classificationFailed += 1;
      options.counters.warnings.push({
        code: "conversation_classification_failed",
        conversationId,
        message: error instanceof Error ? error.message.slice(0, 500) : String(error || "Unknown error").slice(0, 500),
      });
    }
    await sleep(options.input.rateLimitPauseMs);
  }
}

async function syncConversationType(options: {
  supabase: ServiceClient;
  token: string;
  account: EbayAccount;
  runId: string;
  input: SyncInput;
  conversationType: ConversationType;
  counters: Counters;
}) {
  if (options.input.conversationId) {
    const detail = await ebayGet(
      options.token,
      conversationDetailPath(options.input.conversationId, options.conversationType, options.input.messagePageLimit, 0),
    );
    options.counters.detailPagesFetched += 1;
    const conversations = [{
      ...detail,
      conversationId: firstText(detail.conversationId, options.input.conversationId),
      conversationType: options.conversationType,
    }];
    const result = await processConversationPage({
      ...options,
      conversations,
    });
    await classifyProcessedConversations({
      supabase: options.supabase,
      input: options.input,
      conversationIds: result.rowIds,
      counters: options.counters,
    });
    return;
  }

  const checkpoint = ["backfill", "incremental"].includes(options.input.runType)
    ? await beginCheckpoint(options)
    : { resumeOffset: options.input.startOffset, lastConversationTimestamp: null };
  let offset = options.input.runType === "backfill"
    ? checkpoint.resumeOffset
    : options.input.startOffset;
  const pathInput = options.input.runType === "incremental" &&
    options.conversationType === "FROM_MEMBERS" &&
    !options.input.startTime &&
    checkpoint.lastConversationTimestamp
    ? { ...options.input, startTime: checkpoint.lastConversationTimestamp }
    : options.input;
  let conversationsProcessed = 0;
  const messagesProcessedAtStart = options.counters.messagesSeen;
  let latestTimestamp: string | null = null;

  for (let page = 0; options.input.maxConversationPages === null || page < options.input.maxConversationPages; page += 1) {
    const pageIndex = Math.floor(offset / options.input.conversationPageLimit);
    let payload: JsonRecord;
    try {
      payload = await ebayGet(options.token, conversationPath(pathInput, options.conversationType, offset));
      options.counters.pagesFetched += 1;
    } catch (error) {
      options.counters.pagesFailed += 1;
      throw error;
    }

    const pageConversations = (Array.isArray(payload.conversations) ? payload.conversations : []) as JsonRecord[];
    const total = numberOrNull(payload.total);
    options.counters.totalsByConversationType[options.conversationType] = total;
    const result = await processConversationPage({
      ...options,
      conversations: pageConversations,
    });
    await classifyProcessedConversations({
      supabase: options.supabase,
      input: options.input,
      conversationIds: result.rowIds,
      counters: options.counters,
    });

    options.counters.pagesSucceeded += 1;
    const pagesProcessed = pageIndex + 1;
    conversationsProcessed = Math.max(conversationsProcessed, offset + pageConversations.length);
    latestTimestamp = newestTimestamp(latestTimestamp, result.latestTimestamp);

    const exhausted = !pageConversations.length ||
      pageConversations.length < options.input.conversationPageLimit ||
      (typeof total === "number" && offset + options.input.conversationPageLimit >= total);
    const hitPageCap = options.input.maxConversationPages !== null && page + 1 >= options.input.maxConversationPages && !exhausted;
    const nextOffset = exhausted ? 0 : offset + options.input.conversationPageLimit;

    if (["backfill", "incremental"].includes(options.input.runType)) {
      await updateCheckpointProgress({
        ...options,
        lastPageProcessed: pageIndex,
        nextOffset,
        totalAvailable: total,
        pagesProcessed,
        conversationsProcessed,
        messagesProcessed: options.counters.messagesSeen - messagesProcessedAtStart,
        lastConversationTimestamp: latestTimestamp,
        exhausted,
        currentRunComplete: hitPageCap,
      });
    }
    await updateRunProgress(
      options.supabase,
      options.runId,
      options.counters,
      syncRunProgressMetadata(options.input, options.counters, {
        currentConversationType: options.conversationType,
        currentOffset: offset,
        nextOffset,
        exhausted,
      }),
    );

    if (exhausted) break;
    offset = nextOffset;
    await sleep(options.input.rateLimitPauseMs);
  }
}

function backfillEventSummary(input: SyncInput, counters: Counters, startedMs: number, extra: JsonRecord = {}) {
  const failed = counters.pagesFailed + counters.classificationFailed + counters.errors + Number(extra.failed_count || 0);
  const skipped = counters.conversationsSkipped + counters.classificationSkipped;
  return {
    run_type: input.runType,
    classification_mode: input.classificationMode,
    checkpoint_scope: input.checkpointScope,
    conversation_types: input.conversationTypes,
    duration_ms: Math.max(Date.now() - startedMs, 0),
    pages_processed: counters.pagesFetched,
    pages_succeeded: counters.pagesSucceeded,
    pages_failed: counters.pagesFailed,
    conversation_ids: counters.conversationIds,
    conversations_processed: counters.conversationsSeen,
    conversations_succeeded: counters.conversationsSucceeded,
    conversations_inserted: counters.conversationsInserted,
    conversations_updated: counters.conversationsUpdated,
    conversations_skipped: counters.conversationsSkipped,
    messages_processed: counters.messagesSeen,
    messages_inserted: counters.messagesInserted,
    messages_updated: counters.messagesUpdated,
    classification_processed: counters.classificationProcessed,
    classification_succeeded: counters.classificationSucceeded,
    classification_failed: counters.classificationFailed,
    classification_skipped: counters.classificationSkipped,
    processed_count: counters.conversationsSeen,
    succeeded_count: counters.conversationsSucceeded,
    failed_count: failed,
    skipped_count: skipped,
    totals_by_conversation_type: counters.totalsByConversationType,
    warnings_count: counters.warnings.length,
    ...extra,
  };
}

async function recordBackfillActivityEvent(options: {
  supabase: ServiceClient;
  input: SyncInput;
  operator: Operator;
  runId: string;
  counters: Counters;
  startedMs: number;
  eventType: "message_backfill_started" | "message_backfill_completed" | "message_backfill_failed";
  status: "pending" | "succeeded" | "failed" | "warning";
  title: string;
  detail: string;
  extra?: JsonRecord;
}) {
  const summary = backfillEventSummary(options.input, options.counters, options.startedMs, options.extra || {});
  const { error } = await options.supabase.rpc("record_ebay_message_activity_event", {
    _event_type: options.eventType,
    _status: options.status,
    _actor_user_id: options.operator.userId,
    _actor_email: options.operator.email,
    _conversation_id: null,
    _target_message_id: null,
    _draft_id: null,
    _approval_id: null,
    _send_attempt_id: null,
    _classification_id: null,
    _saved_view_id: null,
    _sync_run_id: options.runId,
    _idempotency_key: `${options.eventType}:${options.runId}`,
    _title: options.title,
    _detail: options.detail,
    _metadata: {
      backfill_run: summary,
      ...summary,
      safety: {
        ebay_mutation_performed: false,
        automatic_responses_sent: 0,
        sends_enabled: false,
        read_only: true,
        classification_triggered: options.input.classificationMode !== "none",
      },
    },
  });
  if (error) console.warn("[ebay-message-sync] backfill activity event failed", error.message);
}

function shouldRecordAggregateSyncEvent(input: SyncInput) {
  return input.suppressConversationActivityEvents && input.runType !== "backfill" && !input.conversationId;
}

function syncOperationLabel(input: SyncInput) {
  if (input.runType === "manual") return "Sync Latest";
  if (input.runType === "incremental") return "Incremental Sync";
  if (input.runType === "scheduled") return "Scheduled Sync";
  if (input.runType === "replay") return "Sync Replay";
  return "Message Sync";
}

function syncEventSummary(input: SyncInput, counters: Counters, startedMs: number, extra: JsonRecord = {}) {
  const failed = counters.pagesFailed + counters.classificationFailed + counters.errors + Number(extra.failed_count || 0);
  const skipped = counters.conversationsSkipped + counters.classificationSkipped;
  return {
    run_type: input.runType,
    operation: syncOperationLabel(input),
    classification_mode: input.classificationMode,
    checkpoint_scope: input.checkpointScope,
    conversation_types: input.conversationTypes,
    conversation_ids: counters.conversationIds,
    duration_ms: Math.max(Date.now() - startedMs, 0),
    pages_processed: counters.pagesFetched,
    pages_succeeded: counters.pagesSucceeded,
    pages_failed: counters.pagesFailed,
    detail_pages_processed: counters.detailPagesFetched,
    conversations_seen: counters.conversationsSeen,
    conversations_processed: counters.conversationsSeen,
    conversations_succeeded: counters.conversationsSucceeded,
    conversations_inserted: counters.conversationsInserted,
    conversations_updated: counters.conversationsUpdated,
    conversations_skipped: counters.conversationsSkipped,
    messages_seen: counters.messagesSeen,
    messages_processed: counters.messagesSeen,
    messages_inserted: counters.messagesInserted,
    messages_updated: counters.messagesUpdated,
    classification_processed: counters.classificationProcessed,
    classification_succeeded: counters.classificationSucceeded,
    classification_failed: counters.classificationFailed,
    classification_skipped: counters.classificationSkipped,
    processed_count: counters.conversationsSeen,
    succeeded_count: counters.conversationsSucceeded,
    failed_count: failed,
    skipped_count: skipped,
    totals_by_conversation_type: counters.totalsByConversationType,
    warnings_count: counters.warnings.length,
    warnings: counters.warnings.slice(0, 25),
    ...extra,
  };
}

async function recordSyncActivityEvent(options: {
  supabase: ServiceClient;
  input: SyncInput;
  operator: Operator;
  runId: string;
  counters: Counters;
  startedMs: number;
  eventType: "message_sync_completed" | "message_sync_failed";
  status: "succeeded" | "failed" | "warning";
  extra?: JsonRecord;
}) {
  const summary = syncEventSummary(options.input, options.counters, options.startedMs, options.extra || {});
  const completed = options.eventType === "message_sync_completed";
  const title = `${syncOperationLabel(options.input)} ${completed ? "Completed" : "Failed"}`;
  const detail = completed
    ? `${syncOperationLabel(options.input)} completed. Saw ${options.counters.conversationsSeen} conversations and ${options.counters.messagesSeen} messages.`
    : `${syncOperationLabel(options.input)} failed. Saw ${options.counters.conversationsSeen} conversations and ${options.counters.messagesSeen} messages before failure.`;
  const { error } = await options.supabase.rpc("record_ebay_message_activity_event", {
    _event_type: options.eventType,
    _status: options.status,
    _actor_user_id: options.operator.userId,
    _actor_email: options.operator.email,
    _conversation_id: null,
    _target_message_id: null,
    _draft_id: null,
    _approval_id: null,
    _send_attempt_id: null,
    _classification_id: null,
    _saved_view_id: null,
    _sync_run_id: options.runId,
    _idempotency_key: `${options.eventType}:${options.runId}`,
    _title: title,
    _detail: detail,
    _metadata: {
      sync_run: summary,
      ...summary,
      safety: {
        ebay_mutation_performed: false,
        automatic_responses_sent: 0,
        sends_enabled: false,
        read_only: true,
        classification_triggered: options.input.classificationMode !== "none",
      },
    },
  });
  if (error) console.warn("[ebay-message-sync] aggregate sync activity event failed", error.message);
}

async function completeRun(supabase: ServiceClient, runId: string, counters: Counters, metadata: JsonRecord = {}) {
  const { error } = await supabase
    .from("ebay_message_sync_runs")
    .update({
      status: "succeeded",
      pages_fetched: counters.pagesFetched,
      detail_pages_fetched: counters.detailPagesFetched,
      conversations_seen: counters.conversationsSeen,
      conversations_inserted: counters.conversationsInserted,
      conversations_updated: counters.conversationsUpdated,
      messages_seen: counters.messagesSeen,
      messages_inserted: counters.messagesInserted,
      messages_updated: counters.messagesUpdated,
      media_seen: counters.mediaSeen,
      errors: counters.errors,
      warnings: counters.warnings,
      metadata,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw error;
}

async function failRun(
  supabase: ServiceClient,
  runId: string | null,
  error: unknown,
  counters?: Counters,
  metadata: JsonRecord = {},
) {
  if (!runId) return;
  const syncError = error instanceof SyncError ? error : null;
  await supabase
    .from("ebay_message_sync_runs")
    .update({
      status: "failed",
      pages_fetched: counters?.pagesFetched || 0,
      detail_pages_fetched: counters?.detailPagesFetched || 0,
      conversations_seen: counters?.conversationsSeen || 0,
      conversations_inserted: counters?.conversationsInserted || 0,
      conversations_updated: counters?.conversationsUpdated || 0,
      messages_seen: counters?.messagesSeen || 0,
      messages_inserted: counters?.messagesInserted || 0,
      messages_updated: counters?.messagesUpdated || 0,
      media_seen: counters?.mediaSeen || 0,
      errors: (counters?.errors || 0) + 1,
      warnings: counters?.warnings || [],
      last_error_code: syncError?.code || "unknown_error",
      last_error_message: error instanceof Error ? error.message.slice(0, 1000) : String(error || "Unknown error").slice(0, 1000),
      metadata: {
        ...metadata,
        failure: failureDetails(error),
        failedAt: new Date().toISOString(),
      },
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  let runId: string | null = null;
  let counters: Counters | undefined;
  let input: SyncInput | null = null;
  let operator: Operator | null = null;
  let account: EbayAccount | null = null;
  const startedMs = Date.now();
  const supabase = serviceClient();

  try {
    operator = await requireAdmin(req, supabase);
    input = await parseInput(req);
    account = await upsertSellerAccount(supabase);
    runId = await createRun(supabase, input, account, operator);
    counters = {
      pagesFetched: 0,
      pagesSucceeded: 0,
      pagesFailed: 0,
      detailPagesFetched: 0,
      conversationIds: [],
      conversationsSeen: 0,
      conversationsSucceeded: 0,
      conversationsSkipped: 0,
      conversationsInserted: 0,
      conversationsUpdated: 0,
      messagesSeen: 0,
      messagesInserted: 0,
      messagesUpdated: 0,
      mediaSeen: 0,
      classificationProcessed: 0,
      classificationSucceeded: 0,
      classificationFailed: 0,
      classificationSkipped: 0,
      errors: 0,
      warnings: account.seller_username
        ? []
        : [{ code: "seller_username_not_configured", message: "Set EBAY_SELLER_USERNAME for strongest direction derivation." }],
      totalsByConversationType: {},
    };

    if (input.runType === "backfill") {
      await recordBackfillActivityEvent({
        supabase,
        input,
        operator,
        runId,
        counters,
        startedMs,
        eventType: "message_backfill_started",
        status: "pending",
        title: "Backfill Started",
        detail: `Historical eBay message backfill started for ${input.conversationTypes.join(", ")}.`,
      });
    }

    const token = await refreshEbayToken();
    let successfulConversationTypeSyncs = 0;
    for (const conversationType of input.conversationTypes) {
      try {
        await syncConversationType({
          supabase,
          token,
          account,
          runId,
          input,
          conversationType,
          counters,
        });
        successfulConversationTypeSyncs += 1;
      } catch (error) {
        if (input.conversationId && input.conversationTypes.length > 1 && error instanceof SyncError && error.code === "ebay_api_get_failed") {
          counters.warnings.push({
            code: "conversation_type_detail_failed",
            conversationType,
            conversationId: input.conversationId,
            message: error.message.slice(0, 500),
          });
          continue;
        }
        throw error;
      }
    }
    if (input.conversationId && successfulConversationTypeSyncs === 0) {
      throw new SyncError("conversation_detail_not_found", {
        status: 404,
        phase: "ebay_api",
        message: "Conversation detail could not be fetched for any supported conversation type.",
      });
    }

    await supabase
      .from("ebay_seller_accounts")
      .update({ last_message_sync_at: new Date().toISOString() })
      .eq("id", account.id);

    const metadata = syncRunProgressMetadata(input, counters, {
      conversationTypes: input.conversationTypes,
      conversationId: input.conversationId,
      startOffset: input.startOffset,
      environment: ebayEnvironment(),
      paginationStrategy: "Offsets advance by the exact fixed page limit used for the request.",
      readOnly: true,
      sendsEnabled: false,
      ebayMutationsPerformed: false,
    });
    await completeRun(supabase, runId, counters, metadata);

    if (input.runType === "backfill") {
      const failed = counters.pagesFailed + counters.classificationFailed + counters.errors;
      await recordBackfillActivityEvent({
        supabase,
        input,
        operator,
        runId,
        counters,
        startedMs,
        eventType: "message_backfill_completed",
        status: failed > 0 ? "warning" : "succeeded",
        title: "Backfill Completed",
        detail: `Historical eBay message backfill completed. Processed ${counters.conversationsSeen} conversations and ${counters.messagesSeen} messages.`,
      });
    } else if (shouldRecordAggregateSyncEvent(input)) {
      const failed = counters.pagesFailed + counters.classificationFailed + counters.errors;
      await recordSyncActivityEvent({
        supabase,
        input,
        operator,
        runId,
        counters,
        startedMs,
        eventType: "message_sync_completed",
        status: failed > 0 ? "warning" : "succeeded",
      });
    }

    return json(req, 200, {
      ok: true,
      mode: "sync",
      runType: input.runType,
      classificationMode: input.classificationMode,
      runId,
      sellerAccountId: account.id,
      sellerUsernameConfigured: Boolean(account.seller_username),
      counters,
      durationMs: Math.max(Date.now() - startedMs, 0),
      safety: {
        readOnly: true,
        ebayMutationsPerformed: false,
        sendsEnabled: false,
        messagesSent: 0,
      },
      pagination: {
        conversationPageLimit: input.conversationPageLimit,
        messagePageLimit: input.messagePageLimit,
        startOffset: input.startOffset,
        offsetRule: "startOffset and every continuation offset must be a multiple of the page limit used for that endpoint.",
      },
    });
  } catch (error) {
    await failRunningCheckpoints(supabase, runId, error, counters);
    const failureMetadata = input && counters
      ? syncRunProgressMetadata(input, counters, {
        conversationTypes: input.conversationTypes,
        conversationId: input.conversationId,
        startOffset: input.startOffset,
        environment: ebayEnvironment(),
        readOnly: true,
        sendsEnabled: false,
        ebayMutationsPerformed: false,
      })
      : {};
    await failRun(supabase, runId, error, counters, failureMetadata);
    if (input?.runType === "backfill" && runId && counters && operator) {
      const failure = failureDetails(error);
      const failedCountFallback = counters.pagesFailed + counters.classificationFailed + counters.errors > 0 ? 0 : 1;
      await recordBackfillActivityEvent({
        supabase,
        input,
        operator,
        runId,
        counters,
        startedMs,
        eventType: "message_backfill_failed",
        status: "failed",
        title: "Backfill Failed",
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error || "Historical eBay message backfill failed.").slice(0, 500),
        extra: {
          ...failure,
          failed_count: failedCountFallback,
          error_code: failure.error_code,
          error_phase: failure.error_phase,
        },
      });
    } else if (input && runId && counters && operator && shouldRecordAggregateSyncEvent(input)) {
      const failure = failureDetails(error);
      const failedCountFallback = counters.pagesFailed + counters.classificationFailed + counters.errors > 0 ? 0 : 1;
      await recordSyncActivityEvent({
        supabase,
        input,
        operator,
        runId,
        counters,
        startedMs,
        eventType: "message_sync_failed",
        status: "failed",
        extra: {
          ...failure,
          failed_count: failedCountFallback,
          error_code: failure.error_code,
          error_phase: failure.error_phase,
        },
      });
    }
    const status = error instanceof SyncError ? error.status : 500;
    return json(req, status, {
      ok: false,
      runId,
      error: error instanceof SyncError ? error.code : "unknown_error",
      phase: error instanceof SyncError ? error.phase : "unknown",
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      diagnostic: failureDetails(error),
      safety: {
        readOnly: true,
        ebayMutationsPerformed: false,
        sendsEnabled: false,
        messagesSent: 0,
      },
    });
  }
});
