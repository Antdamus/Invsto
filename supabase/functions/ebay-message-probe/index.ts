import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ServiceClient = ReturnType<typeof createClient>;
type JsonRecord = Record<string, unknown>;
type ConversationType = "FROM_MEMBERS" | "FROM_EBAY";

type Operator = {
  actorType: "service_role" | "admin";
  userId: string | null;
  email: string | null;
};

type ProbeInput = {
  mode: "probe";
  conversationType: ConversationType | null;
  limit: number;
  offset: number;
  startTime: string | null;
  endTime: string | null;
  otherPartyUsername: string | null;
  referenceId: string | null;
  includeDetails: boolean;
  conversationId: string | null;
};

type TokenRefreshDiagnostic = {
  ok: boolean;
  errorCategory?: string;
  status?: number;
  message?: string;
};

type ApiDiagnostic = {
  ok: boolean;
  errorCategory?: string;
  status?: number;
  message?: string;
};

type ConversationSample = {
  conversationId: string;
  conversationType?: string;
  conversationStatus?: string;
  title?: string;
  otherPartyUsername?: string;
  unreadCount?: number;
  latestMessageCreatedDate?: string;
  latestMessagePreview?: string;
  referenceId?: string;
  referenceType?: string;
  rawKeys: string[];
};

type ConversationSet = {
  conversationType: ConversationType;
  count: number;
  total?: number;
  samples: ConversationSample[];
  api: ApiDiagnostic;
};

type DetailSample = {
  conversationId: string;
  messageCount: number;
  messages: Array<{
    messageId?: string;
    senderUsername?: string;
    recipientUsername?: string;
    createdDate?: string;
    subject?: string;
    bodyPreview?: string;
    read?: boolean;
    hasMedia?: boolean;
    rawKeys: string[];
  }>;
  rawKeys: string[];
  api?: ApiDiagnostic;
};

const DEFAULT_MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
const SAFE_LIMIT_DEFAULT = 5;
const SAFE_LIMIT_MAX = 10;
const DETAIL_CONVERSATION_MAX = 3;
const DETAIL_MESSAGE_LIMIT = 5;
const BODY_PREVIEW_MAX = 180;
const SUBJECT_PREVIEW_MAX = 120;
const SUPPORTED_CONVERSATION_TYPES = ["FROM_MEMBERS", "FROM_EBAY"] as const;

class ProbeError extends Error {
  code: string;
  status: number;
  phase: string;

  constructor(code: string, options: { status?: number; phase?: string } = {}) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "probe";
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
  if (!value) throw new ProbeError("configuration_error", { status: 500, phase: "configuration" });
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
  if (!accessToken) throw new ProbeError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new ProbeError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new ProbeError("configuration_error", { status: 500, phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new ProbeError("admin_required", { status: 403, phase: "auth" });
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

async function parseInput(req: Request): Promise<ProbeInput> {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const getValue = (name: string) => body?.[name] ?? url.searchParams.get(name);
  const mode = String(getValue("mode") || "probe").trim();
  if (mode !== "probe") throw new ProbeError("invalid_mode", { status: 400, phase: "input" });

  const requestedConversationType = stringOrNull(getValue("conversationType"));
  if (requestedConversationType && !SUPPORTED_CONVERSATION_TYPES.includes(requestedConversationType as ConversationType)) {
    throw new ProbeError("invalid_conversation_type", { status: 400, phase: "input" });
  }

  return {
    mode: "probe",
    conversationType: requestedConversationType as ConversationType | null,
    limit: boundedInteger(getValue("limit"), SAFE_LIMIT_DEFAULT, 1, SAFE_LIMIT_MAX),
    offset: boundedInteger(getValue("offset"), 0, 0, 500),
    startTime: stringOrNull(getValue("startTime")),
    endTime: stringOrNull(getValue("endTime")),
    otherPartyUsername: stringOrNull(getValue("otherPartyUsername")),
    referenceId: stringOrNull(getValue("referenceId")),
    includeDetails: getValue("includeDetails") === true || String(getValue("includeDetails") || "").toLowerCase() === "true",
    conversationId: stringOrNull(getValue("conversationId")),
  };
}

function rawKeys(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as JsonRecord).sort() : [];
}

function text(value: unknown) {
  return String(value || "").trim();
}

function numberOrUndefined(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function booleanOrUndefined(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function preview(value: unknown, maxLength = BODY_PREVIEW_MAX) {
  const cleaned = decodeEntities(text(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
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

function ebayEnvironment() {
  const value = (Deno.env.get("EBAY_ENV") || "production").trim().toLowerCase();
  if (value === "sandbox") return "sandbox";
  if (value === "production") return "production";
  return "unknown";
}

function ebayApiBase() {
  return ebayEnvironment() === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

function classifyAuthError(status: number, payload: unknown) {
  const message = safeMessage(payload).toLowerCase();
  const code = typeof payload === "object" && payload !== null ? text((payload as JsonRecord).error).toLowerCase() : "";
  if (code === "invalid_client" || status === 401 && message.includes("client")) return "invalid_client";
  if (code === "invalid_scope" || message.includes("invalid scope")) return "invalid_scope";
  if (message.includes("scope") && (message.includes("grant") || message.includes("consent") || message.includes("not allowed"))) {
    return "scope_not_granted";
  }
  if (code === "invalid_grant" || message.includes("refresh token") || message.includes("invalid grant")) return "invalid_refresh_token";
  if (message.includes("oauth")) return "ebay_auth_error";
  return "unknown_auth_error";
}

function classifyApiError(status: number, payload: unknown) {
  const message = safeMessage(payload).toLowerCase();
  if ((status === 401 || status === 403) && (
    message.includes("commerce.message") ||
    message.includes("scope") ||
    message.includes("insufficient") ||
    message.includes("privilege") ||
    message.includes("permission")
  )) {
    return "missing_commerce_message_scope";
  }
  if (status === 401 || status === 403) return "forbidden_or_not_authorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400) return "ebay_api_error";
  return "unknown_api_error";
}

async function refreshEbayToken(scopeRequested: string): Promise<{ token?: string; diagnostic: TokenRefreshDiagnostic }> {
  const clientId = optionalEnv("EBAY_CLIENT_ID", "EBAY_APP_ID");
  const clientSecret = optionalEnv("EBAY_CLIENT_SECRET", "EBAY_CERT_ID");
  const refreshToken = optionalEnv("EBAY_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      diagnostic: {
        ok: false,
        errorCategory: "missing_secret",
        message: "Missing one or more required eBay OAuth secrets.",
      },
    };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopeRequested,
  });

  let res: Response;
  try {
    res = await fetch(`${ebayApiBase()}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (error) {
    return {
      diagnostic: {
        ok: false,
        errorCategory: "unknown_auth_error",
        message: error instanceof Error ? error.message.slice(0, 300) : "Network error refreshing eBay token.",
      },
    };
  }

  const payload = await parseResponse(res);
  if (!res.ok) {
    return {
      diagnostic: {
        ok: false,
        errorCategory: classifyAuthError(res.status, payload),
        status: res.status,
        message: safeMessage(payload),
      },
    };
  }

  const token = text((payload as JsonRecord).access_token);
  if (!token) {
    return {
      diagnostic: {
        ok: false,
        errorCategory: "unknown_auth_error",
        status: res.status,
        message: "eBay OAuth response did not include an access token.",
      },
    };
  }

  return { token, diagnostic: { ok: true, status: res.status } };
}

async function ebayGet(token: string, path: string): Promise<{ ok: true; payload: JsonRecord; status: number } | { ok: false; api: ApiDiagnostic }> {
  try {
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
    if (!res.ok) {
      return {
        ok: false,
        api: {
          ok: false,
          errorCategory: classifyApiError(res.status, payload),
          status: res.status,
          message: safeMessage(payload),
        },
      };
    }
    return { ok: true, payload: payload as JsonRecord, status: res.status };
  } catch (error) {
    return {
      ok: false,
      api: {
        ok: false,
        errorCategory: error instanceof TypeError ? "network_error" : "unknown_api_error",
        message: error instanceof Error ? error.message.slice(0, 300) : "Unknown eBay API request failure.",
      },
    };
  }
}

function otherPartyUsername(conversation: JsonRecord) {
  return text(conversation.otherPartyUsername) ||
    text((conversation.otherParty as JsonRecord | undefined)?.username) ||
    text((conversation.participant as JsonRecord | undefined)?.username) ||
    undefined;
}

function latestMessage(conversation: JsonRecord) {
  return conversation.latestMessage && typeof conversation.latestMessage === "object"
    ? conversation.latestMessage as JsonRecord
    : {};
}

function toConversationSample(value: unknown): ConversationSample {
  const conversation = value && typeof value === "object" ? value as JsonRecord : {};
  const latest = latestMessage(conversation);
  return {
    conversationId: text(conversation.conversationId),
    conversationType: text(conversation.conversationType) || undefined,
    conversationStatus: text(conversation.conversationStatus) || undefined,
    title: preview(conversation.conversationTitle ?? conversation.title, SUBJECT_PREVIEW_MAX) || undefined,
    otherPartyUsername: otherPartyUsername(conversation),
    unreadCount: numberOrUndefined(conversation.unreadCount),
    latestMessageCreatedDate: text(latest.createdDate) || text(conversation.createdDate) || undefined,
    latestMessagePreview: preview(latest.messageBody) || undefined,
    referenceId: text(conversation.referenceId) || undefined,
    referenceType: text(conversation.referenceType) || undefined,
    rawKeys: rawKeys(conversation),
  };
}

function toMessageSample(value: unknown) {
  const message = value && typeof value === "object" ? value as JsonRecord : {};
  const media = Array.isArray(message.messageMedia) ? message.messageMedia : [];
  return {
    messageId: text(message.messageId) || undefined,
    senderUsername: text(message.senderUsername) || undefined,
    recipientUsername: text(message.recipientUsername) || undefined,
    createdDate: text(message.createdDate) || undefined,
    subject: preview(message.subject, SUBJECT_PREVIEW_MAX) || undefined,
    bodyPreview: preview(message.messageBody) || undefined,
    read: booleanOrUndefined(message.readStatus),
    hasMedia: media.length > 0,
    rawKeys: rawKeys(message),
  };
}

function conversationPath(input: ProbeInput, conversationType: ConversationType) {
  const params = new URLSearchParams({
    conversation_type: conversationType,
    limit: String(input.limit),
    offset: String(input.offset),
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

function conversationDetailPath(conversationId: string, conversationType: ConversationType, limit = DETAIL_MESSAGE_LIMIT) {
  const params = new URLSearchParams({
    conversation_type: conversationType,
    limit: String(Math.min(Math.max(limit, 1), DETAIL_MESSAGE_LIMIT)),
    offset: "0",
  });
  return `/commerce/message/v1/conversation/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

async function fetchConversationSet(token: string, input: ProbeInput, conversationType: ConversationType): Promise<ConversationSet> {
  const result = await ebayGet(token, conversationPath(input, conversationType));
  if (!result.ok) {
    return {
      conversationType,
      count: 0,
      samples: [],
      api: result.api,
    };
  }

  const conversations = Array.isArray(result.payload.conversations) ? result.payload.conversations : [];
  return {
    conversationType,
    count: conversations.length,
    total: numberOrUndefined(result.payload.total),
    samples: conversations.slice(0, SAFE_LIMIT_MAX).map(toConversationSample).filter((sample) => sample.conversationId),
    api: { ok: true, status: result.status },
  };
}

async function fetchDetail(token: string, conversationId: string, conversationType: ConversationType): Promise<DetailSample> {
  const result = await ebayGet(token, conversationDetailPath(conversationId, conversationType));
  if (!result.ok) {
    return {
      conversationId,
      messageCount: 0,
      messages: [],
      rawKeys: [],
      api: result.api,
    };
  }

  const messages = Array.isArray(result.payload.messages) ? result.payload.messages : [];
  return {
    conversationId,
    messageCount: numberOrUndefined(result.payload.total) ?? messages.length,
    messages: messages.slice(0, DETAIL_MESSAGE_LIMIT).map(toMessageSample),
    rawKeys: rawKeys(result.payload),
    api: { ok: true, status: result.status },
  };
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function coverage(conversationSets: ConversationSet[], details: DetailSample[]) {
  const samples = conversationSets.flatMap((set) => set.samples);
  const messages = details.flatMap((detail) => detail.messages);
  const latestMessages = conversationSets.flatMap((set) => set.samples.map((sample) => sample.latestMessagePreview).filter(Boolean));
  return {
    hasConversationIds: samples.some((sample) => Boolean(sample.conversationId)) || details.some((detail) => Boolean(detail.conversationId)),
    hasUnreadCounts: samples.some((sample) => typeof sample.unreadCount === "number"),
    hasOtherPartyUsernames: samples.some((sample) => Boolean(sample.otherPartyUsername)),
    hasLatestMessages: latestMessages.length > 0,
    hasListingReferences: samples.some((sample) => Boolean(sample.referenceId || sample.referenceType)),
    hasCleanMessageBodies: latestMessages.length > 0 || messages.some((message) => Boolean(message.bodyPreview)),
    hasSenderRecipientUsernames: messages.some((message) => Boolean(message.senderUsername && message.recipientUsername)),
    hasTimestamps: samples.some((sample) => Boolean(sample.latestMessageCreatedDate)) || messages.some((message) => Boolean(message.createdDate)),
    hasReadStatus: messages.some((message) => typeof message.read === "boolean"),
    hasMedia: messages.some((message) => message.hasMedia === true),
  };
}

function correlationHints(conversationSets: ConversationSet[], details: DetailSample[]) {
  const samples = conversationSets.flatMap((set) => set.samples);
  const messages = details.flatMap((detail) => detail.messages);
  return {
    possibleBuyerUsernames: unique([
      ...samples.map((sample) => sample.otherPartyUsername),
      ...messages.map((message) => message.senderUsername),
      ...messages.map((message) => message.recipientUsername),
    ]).slice(0, 20),
    possibleReferenceIds: unique(samples.map((sample) => sample.referenceId)).slice(0, 20),
    possibleSubjects: unique([
      ...samples.map((sample) => sample.title),
      ...messages.map((message) => message.subject),
    ]).slice(0, 20),
  };
}

function nextRequiredAction(tokenRefresh: TokenRefreshDiagnostic, apiDiagnostics: ApiDiagnostic[]) {
  if (!tokenRefresh.ok) {
    if (tokenRefresh.errorCategory === "missing_secret" || tokenRefresh.errorCategory === "invalid_client") {
      return "Check Supabase secrets.";
    }
    if (["invalid_scope", "scope_not_granted", "invalid_refresh_token"].includes(tokenRefresh.errorCategory || "")) {
      return "Reconnect eBay OAuth with commerce.message.";
    }
    return "Check deployed function config.";
  }

  const failed = apiDiagnostics.find((api) => !api.ok);
  if (!failed) return "No action: current token works.";

  if (failed.errorCategory === "missing_commerce_message_scope") {
    return "Reconnect eBay OAuth with commerce.message.";
  }
  if (failed.errorCategory === "forbidden_or_not_authorized") {
    return "Confirm commerce.message is enabled in Developer Portal.";
  }
  if (failed.errorCategory === "network_error") {
    return "Check deployed function config.";
  }
  return "Check deployed function config.";
}

function warningsFor(input: ProbeInput, conversationSets: ConversationSet[], details: DetailSample[]) {
  const warnings: string[] = [
    "Probe is read-only; it calls only Commerce Message API GET endpoints.",
    `Body previews are capped at ${BODY_PREVIEW_MAX} characters and full message bodies are not returned.`,
  ];
  if (!input.conversationType && !input.conversationId) {
    warnings.push("No conversationType was supplied, so the probe sampled both FROM_MEMBERS and FROM_EBAY.");
  }
  if (input.limit === SAFE_LIMIT_MAX) {
    warnings.push(`Requested limit was capped at ${SAFE_LIMIT_MAX}.`);
  }
  if ((input.startTime || input.endTime) && input.conversationType === "FROM_EBAY") {
    warnings.push("eBay only documents start_time/end_time filters for FROM_MEMBERS; those filters were not sent for FROM_EBAY.");
  }
  for (const set of conversationSets) {
    if (!set.api.ok) warnings.push(`${set.conversationType} probe failed: ${set.api.errorCategory || "unknown_api_error"}.`);
  }
  for (const detail of details) {
    if (detail.api && !detail.api.ok) warnings.push(`Conversation detail failed for ${detail.conversationId}: ${detail.api.errorCategory || "unknown_api_error"}.`);
  }
  return warnings;
}

async function runProbe(input: ProbeInput) {
  const scopeRequested = (Deno.env.get("EBAY_MESSAGE_SCOPE") || DEFAULT_MESSAGE_SCOPE).trim() || DEFAULT_MESSAGE_SCOPE;
  const tokenResult = await refreshEbayToken(scopeRequested);
  const emptySet: ConversationSet = {
    conversationType: input.conversationType || "FROM_MEMBERS",
    count: 0,
    samples: [],
    api: { ok: false, errorCategory: "ebay_api_error", message: "Skipped because token refresh failed." },
  };

  if (!tokenResult.token) {
    return {
      ok: false,
      mode: "probe",
      environment: ebayEnvironment(),
      scopeRequested,
      tokenRefresh: tokenResult.diagnostic,
      conversations: emptySet,
      conversationSets: [emptySet],
      fieldCoverage: coverage([emptySet], []),
      correlationHints: correlationHints([emptySet], []),
      warnings: ["Token refresh failed; no Commerce Message API calls were made."],
      nextRequiredAction: nextRequiredAction(tokenResult.diagnostic, []),
    };
  }

  const token = tokenResult.token;
  const requestedTypes: ConversationType[] = input.conversationId
    ? (input.conversationType ? [input.conversationType] : ["FROM_MEMBERS", "FROM_EBAY"])
    : (input.conversationType ? [input.conversationType] : ["FROM_MEMBERS", "FROM_EBAY"]);

  const conversationSets = input.conversationId
    ? requestedTypes.map((conversationType) => ({
      conversationType,
      count: 0,
      samples: [],
      api: { ok: true },
    } as ConversationSet))
    : await Promise.all(requestedTypes.map((conversationType) => fetchConversationSet(token, input, conversationType)));

  const details: DetailSample[] = [];
  if (input.conversationId) {
    const failedAttempts: DetailSample[] = [];
    for (const conversationType of requestedTypes) {
      const detail = await fetchDetail(token, input.conversationId, conversationType);
      if (detail.api?.ok) {
        details.push(detail);
        break;
      }
      failedAttempts.push(detail);
    }
    if (!details.length) details.push(...failedAttempts);
  } else if (input.includeDetails) {
    const detailTargets = conversationSets
      .flatMap((set) => set.samples.map((sample) => ({ conversationId: sample.conversationId, conversationType: set.conversationType })))
      .slice(0, DETAIL_CONVERSATION_MAX);
    for (const target of detailTargets) {
      details.push(await fetchDetail(token, target.conversationId, target.conversationType));
    }
  }

  const apiDiagnostics = [
    ...conversationSets.map((set) => set.api),
    ...details.map((detail) => detail.api).filter((api): api is ApiDiagnostic => Boolean(api)),
  ];
  const ok = tokenResult.diagnostic.ok && apiDiagnostics.every((api) => api.ok);
  const primarySet = conversationSets[0] || emptySet;

  return {
    ok,
    mode: "probe",
    environment: ebayEnvironment(),
    scopeRequested,
    tokenRefresh: tokenResult.diagnostic,
    conversations: primarySet,
    conversationSets,
    details: details.length ? details : undefined,
    fieldCoverage: coverage(conversationSets, details),
    correlationHints: correlationHints(conversationSets, details),
    warnings: warningsFor(input, conversationSets, details),
    nextRequiredAction: nextRequiredAction(tokenResult.diagnostic, apiDiagnostics),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") {
    return json(req, 405, { ok: false, error: "method_not_allowed", allowedMethods: ["POST", "OPTIONS"] });
  }

  try {
    const supabase = serviceClient();
    await requireAdmin(req, supabase);
    const input = await parseInput(req);
    return json(req, 200, await runProbe(input));
  } catch (error) {
    if (error instanceof ProbeError) {
      return json(req, error.status, { ok: false, error: error.code, phase: error.phase });
    }
    const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown probe failure.";
    return json(req, 500, { ok: false, error: "unknown_probe_error", message });
  }
});
