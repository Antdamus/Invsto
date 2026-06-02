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

type MessageDirection = "inbound" | "outbound" | "platform" | "unknown";
type DirectionConfidence = "strong" | "medium" | "weak" | "unknown";

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
  createdDate?: string;
  rawKeys: string[];
  latestMessageKeys: string[];
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
  conversationType: ConversationType;
  conversationStatus?: string;
  title?: string;
  otherPartyUsername?: string;
  referenceId?: string;
  referenceType?: string;
  messageCount: number;
  messages: Array<{
    messageId?: string;
    senderUsername?: string;
    recipientUsername?: string;
    direction?: MessageDirection;
    directionConfidence?: DirectionConfidence;
    directionReason?: string;
    createdDate?: string;
    subject?: string;
    bodyPreview?: string;
    bodyLength?: number;
    bodyShape?: {
      hasHtmlTags: boolean;
      hasHtmlEntities: boolean;
      hasQuotedReplyMarkers: boolean;
      hasLikelyEbayTemplateText: boolean;
    };
    read?: boolean;
    readStatus?: string;
    messageStatus?: string;
    hasMedia?: boolean;
    mediaCount?: number;
    mediaSamples?: Array<{
      mediaType?: string;
      mediaName?: string;
      mediaUrlPresent: boolean;
      rawKeys: string[];
    }>;
    pageOffset?: number;
    rawKeys: string[];
  }>;
  pagination: {
    total?: number;
    firstPageCount: number;
    firstPageLimit: number;
    secondPageFetched: boolean;
    secondPageOffset?: number;
    secondPageCount?: number;
    duplicateMessageIdsAcrossFetchedPages: string[];
    payloadPaginationKeys: string[];
    secondPageApi?: ApiDiagnostic;
  };
  orderingAnalysis: {
    comparableTimestampCount: number;
    observedOrder: "ascending" | "descending" | "single_or_equal" | "mixed_or_unknown";
    stableMessageIds: boolean;
    duplicateMessageIds: string[];
    duplicateBodyPreviews: string[];
  };
  participantAnalysis: {
    usernames: string[];
    otherPartyUsername?: string;
    sellerUsernameCandidates: string[];
    allMessagesHaveSenderRecipient: boolean;
    directionHeuristic: string;
  };
  missingFields: string[];
  suspiciousFields: string[];
  rawKeys: string[];
  api?: ApiDiagnostic;
};

const DEFAULT_MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
const SAFE_LIMIT_DEFAULT = 5;
const SAFE_LIMIT_MAX = 10;
const DETAIL_CONVERSATION_MAX = 3;
const DETAIL_MESSAGE_LIMIT = 5;
const DETAIL_SECOND_PAGE_LIMIT = 2;
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

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
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

function uniqueText(values: unknown[]) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function firstText(...values: unknown[]) {
  return values.map((value) => text(value)).find(Boolean) || "";
}

function firstArray(...values: unknown[]) {
  return values.find((value) => Array.isArray(value)) as unknown[] | undefined;
}

function containsHtmlTags(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function bodyShape(value: unknown) {
  const raw = text(value);
  return {
    hasHtmlTags: containsHtmlTags(raw),
    hasHtmlEntities: /&(?:nbsp|amp|lt|gt|quot|#39);/i.test(raw),
    hasQuotedReplyMarkers: /\b(original message|wrote:|from:|sent:|to:|subject:)\b/i.test(raw),
    hasLikelyEbayTemplateText: /\b(eBay sent this message|learn more about|privacy notice|marketplace safety|unsubscribe|reply to this message)\b/i.test(raw),
  };
}

function normalizedBodyKey(value: unknown) {
  return preview(value, 120).toLowerCase().replace(/\s+/g, " ").trim();
}

function duplicateValues(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
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
    text(recordOrEmpty(conversation.otherParty).username) ||
    text(recordOrEmpty(conversation.participant).username) ||
    undefined;
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
  ) || undefined;
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
  ) || undefined;
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
    referenceId: referenceId(conversation),
    referenceType: referenceType(conversation),
    createdDate: text(conversation.createdDate) || undefined,
    rawKeys: rawKeys(conversation),
    latestMessageKeys: rawKeys(latest),
  };
}

function mediaSamples(value: unknown) {
  const media = firstArray(value) || [];
  return media.slice(0, 3).map((entry) => {
    const record = recordOrEmpty(entry);
    return {
      mediaType: firstText(record.mediaType, record.type, record.contentType) || undefined,
      mediaName: preview(firstText(record.mediaName, record.name, record.fileName), SUBJECT_PREVIEW_MAX) || undefined,
      mediaUrlPresent: Boolean(firstText(record.mediaUrl, record.url, record.href, record.downloadUrl)),
      rawKeys: rawKeys(record),
    };
  });
}

function inferDirection(
  senderUsername: string | undefined,
  recipientUsername: string | undefined,
  otherParty: string | undefined,
  conversationType: ConversationType,
): { direction: MessageDirection; confidence: DirectionConfidence; reason: string } {
  if (conversationType === "FROM_EBAY") {
    return { direction: "platform", confidence: "medium", reason: "Conversation type is FROM_EBAY." };
  }
  if (!senderUsername || !recipientUsername) {
    return { direction: "unknown", confidence: "unknown", reason: "Sender or recipient username is missing." };
  }
  if (otherParty) {
    if (senderUsername.toLowerCase() === otherParty.toLowerCase()) {
      return { direction: "inbound", confidence: "strong", reason: "Sender matches otherPartyUsername." };
    }
    if (recipientUsername.toLowerCase() === otherParty.toLowerCase()) {
      return { direction: "outbound", confidence: "strong", reason: "Recipient matches otherPartyUsername." };
    }
    return { direction: "unknown", confidence: "weak", reason: "Sender/recipient do not match otherPartyUsername." };
  }
  return {
    direction: "unknown",
    confidence: "weak",
    reason: "Sender and recipient are present, but seller/other-party identity is not known in this response.",
  };
}

function toMessageSample(value: unknown, options: {
  conversationType: ConversationType;
  otherPartyUsername?: string;
  pageOffset: number;
}) {
  const message = value && typeof value === "object" ? value as JsonRecord : {};
  const body = firstText(message.messageBody, message.body, message.text);
  const media = firstArray(message.messageMedia, message.media, message.attachments) || [];
  const senderUsername = firstText(message.senderUsername, recordOrEmpty(message.sender).username) || undefined;
  const recipientUsername = firstText(message.recipientUsername, recordOrEmpty(message.recipient).username) || undefined;
  const direction = inferDirection(senderUsername, recipientUsername, options.otherPartyUsername, options.conversationType);
  return {
    messageId: firstText(message.messageId, message.id) || undefined,
    senderUsername,
    recipientUsername,
    direction: direction.direction,
    directionConfidence: direction.confidence,
    directionReason: direction.reason,
    createdDate: firstText(message.createdDate, message.creationDate, message.sentDate) || undefined,
    subject: preview(firstText(message.subject, message.title), SUBJECT_PREVIEW_MAX) || undefined,
    bodyPreview: preview(body) || undefined,
    bodyLength: body.length || undefined,
    bodyShape: bodyShape(body),
    read: booleanOrUndefined(message.readStatus),
    readStatus: text(message.readStatus) || undefined,
    messageStatus: firstText(message.messageStatus, message.status) || undefined,
    hasMedia: media.length > 0,
    mediaCount: media.length,
    mediaSamples: mediaSamples(media),
    pageOffset: options.pageOffset,
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

function conversationDetailPath(conversationId: string, conversationType: ConversationType, limit = DETAIL_MESSAGE_LIMIT, offset = 0) {
  const params = new URLSearchParams({
    conversation_type: conversationType,
    limit: String(Math.min(Math.max(limit, 1), DETAIL_MESSAGE_LIMIT)),
    offset: String(Math.max(Math.trunc(offset), 0)),
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

function observedMessageOrder(messages: DetailSample["messages"]) {
  const timestamps = messages.map((message) => Date.parse(message.createdDate || "")).filter(Number.isFinite);
  if (timestamps.length < 2) return "single_or_equal" as const;
  const ascending = timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]);
  const descending = timestamps.every((value, index) => index === 0 || value <= timestamps[index - 1]);
  if (ascending && descending) return "single_or_equal" as const;
  if (ascending) return "ascending" as const;
  if (descending) return "descending" as const;
  return "mixed_or_unknown" as const;
}

function detailOrderingAnalysis(messages: DetailSample["messages"]): DetailSample["orderingAnalysis"] {
  const messageIds = messages.map((message) => message.messageId).filter((value): value is string => Boolean(value));
  const bodyKeys = messages.map((message) => normalizedBodyKey(message.bodyPreview)).filter(Boolean);
  return {
    comparableTimestampCount: messages.filter((message) => Number.isFinite(Date.parse(message.createdDate || ""))).length,
    observedOrder: observedMessageOrder(messages),
    stableMessageIds: messageIds.length === messages.length && duplicateValues(messageIds).length === 0,
    duplicateMessageIds: duplicateValues(messageIds),
    duplicateBodyPreviews: duplicateValues(bodyKeys).slice(0, 5),
  };
}

function detailParticipantAnalysis(
  messages: DetailSample["messages"],
  otherPartyUsername: string | undefined,
  conversationType: ConversationType,
): DetailSample["participantAnalysis"] {
  const usernames = uniqueText([
    ...messages.map((message) => message.senderUsername),
    ...messages.map((message) => message.recipientUsername),
  ]);
  const sellerUsernameCandidates = otherPartyUsername
    ? usernames.filter((username) => username.toLowerCase() !== otherPartyUsername.toLowerCase())
    : [];
  const allMessagesHaveSenderRecipient = messages.length > 0 &&
    messages.every((message) => Boolean(message.senderUsername && message.recipientUsername));
  let directionHeuristic = "Direction is unknown until seller/other-party identity is available.";
  if (conversationType === "FROM_EBAY") {
    directionHeuristic = "Treat FROM_EBAY messages as platform/system messages unless payload fields prove a member participant.";
  } else if (otherPartyUsername && allMessagesHaveSenderRecipient) {
    directionHeuristic = "Inbound when senderUsername equals otherPartyUsername; outbound when recipientUsername equals otherPartyUsername.";
  } else if (allMessagesHaveSenderRecipient) {
    directionHeuristic = "Sender/recipient usernames are present, so direction can be inferred after storing seller account username or joining to conversation otherPartyUsername.";
  }
  return {
    usernames,
    otherPartyUsername,
    sellerUsernameCandidates,
    allMessagesHaveSenderRecipient,
    directionHeuristic,
  };
}

function expectedMissingFields(detail: JsonRecord, messages: DetailSample["messages"]) {
  const missing: string[] = [];
  if (!text(detail.conversationId)) missing.push("conversationId");
  if (!text(detail.conversationStatus)) missing.push("conversationStatus");
  if (!text(detail.conversationType)) missing.push("conversationType");
  if (!Array.isArray(detail.messages)) missing.push("messages[]");
  if (messages.some((message) => !message.messageId)) missing.push("message.messageId");
  if (messages.some((message) => !message.senderUsername)) missing.push("message.senderUsername");
  if (messages.some((message) => !message.recipientUsername)) missing.push("message.recipientUsername");
  if (messages.some((message) => !message.createdDate)) missing.push("message.createdDate");
  if (messages.some((message) => !message.bodyPreview)) missing.push("message.messageBody");
  return [...new Set(missing)];
}

function suspiciousDetailFields(messages: DetailSample["messages"], pagination: DetailSample["pagination"]) {
  const suspicious: string[] = [];
  if (messages.some((message) => message.bodyShape?.hasHtmlTags)) suspicious.push("At least one message body contains HTML tags.");
  if (messages.some((message) => message.bodyShape?.hasQuotedReplyMarkers)) suspicious.push("At least one message body has quoted-reply markers.");
  if (messages.some((message) => message.bodyShape?.hasLikelyEbayTemplateText)) suspicious.push("At least one message body looks like an eBay notification template.");
  if (duplicateValues(messages.map((message) => message.messageId || "").filter(Boolean)).length) suspicious.push("Duplicate message IDs were observed.");
  if (pagination.secondPageApi && !pagination.secondPageApi.ok) suspicious.push("Second-page pagination probe failed.");
  return suspicious;
}

async function fetchDetail(
  token: string,
  conversationId: string,
  conversationType: ConversationType,
  header?: ConversationSample,
): Promise<DetailSample> {
  const result = await ebayGet(token, conversationDetailPath(conversationId, conversationType));
  if (!result.ok) {
    return {
      conversationId,
      conversationType,
      messageCount: 0,
      messages: [],
      pagination: {
        firstPageCount: 0,
        firstPageLimit: DETAIL_MESSAGE_LIMIT,
        secondPageFetched: false,
        duplicateMessageIdsAcrossFetchedPages: [],
        payloadPaginationKeys: [],
      },
      orderingAnalysis: detailOrderingAnalysis([]),
      participantAnalysis: detailParticipantAnalysis([], header?.otherPartyUsername, conversationType),
      missingFields: [],
      suspiciousFields: [],
      rawKeys: [],
      api: result.api,
    };
  }

  const firstPageMessages = Array.isArray(result.payload.messages) ? result.payload.messages : [];
  const total = numberOrUndefined(result.payload.total);
  const secondPageOffset = firstPageMessages.length;
  let secondPageMessages: unknown[] = [];
  let secondPageApi: ApiDiagnostic | undefined;
  if (typeof total === "number" && total > firstPageMessages.length && firstPageMessages.length > 0) {
    const secondResult = await ebayGet(
      token,
      conversationDetailPath(conversationId, conversationType, DETAIL_SECOND_PAGE_LIMIT, secondPageOffset),
    );
    if (secondResult.ok) {
      secondPageMessages = Array.isArray(secondResult.payload.messages) ? secondResult.payload.messages : [];
      secondPageApi = { ok: true, status: secondResult.status };
    } else {
      secondPageApi = secondResult.api;
    }
  }

  const detailOtherPartyUsername = otherPartyUsername(result.payload) || header?.otherPartyUsername;
  const messages = [
    ...firstPageMessages.map((message) => toMessageSample(message, {
      conversationType,
      otherPartyUsername: detailOtherPartyUsername,
      pageOffset: 0,
    })),
    ...secondPageMessages.map((message) => toMessageSample(message, {
      conversationType,
      otherPartyUsername: detailOtherPartyUsername,
      pageOffset: secondPageOffset,
    })),
  ];
  const pagination = {
    total,
    firstPageCount: firstPageMessages.length,
    firstPageLimit: DETAIL_MESSAGE_LIMIT,
    secondPageFetched: secondPageMessages.length > 0 || Boolean(secondPageApi),
    secondPageOffset: secondPageApi ? secondPageOffset : undefined,
    secondPageCount: secondPageApi ? secondPageMessages.length : undefined,
    duplicateMessageIdsAcrossFetchedPages: duplicateValues(messages.map((message) => message.messageId || "").filter(Boolean)),
    payloadPaginationKeys: rawKeys(result.payload).filter((key) => ["href", "limit", "next", "offset", "prev", "total"].includes(key)),
    secondPageApi,
  };
  return {
    conversationId,
    conversationType,
    conversationStatus: firstText(result.payload.conversationStatus, header?.conversationStatus) || undefined,
    title: preview(firstText(result.payload.conversationTitle, result.payload.title, header?.title), SUBJECT_PREVIEW_MAX) || undefined,
    otherPartyUsername: detailOtherPartyUsername,
    referenceId: referenceId(result.payload) || header?.referenceId,
    referenceType: referenceType(result.payload) || header?.referenceType,
    messageCount: total ?? messages.length,
    messages,
    pagination,
    orderingAnalysis: detailOrderingAnalysis(messages),
    participantAnalysis: detailParticipantAnalysis(messages, detailOtherPartyUsername, conversationType),
    missingFields: expectedMissingFields(result.payload, messages),
    suspiciousFields: suspiciousDetailFields(messages, pagination),
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
    hasOtherPartyUsernames: samples.some((sample) => Boolean(sample.otherPartyUsername)) || details.some((detail) => Boolean(detail.otherPartyUsername)),
    hasLatestMessages: latestMessages.length > 0,
    hasListingReferences: samples.some((sample) => Boolean(sample.referenceId || sample.referenceType)) ||
      details.some((detail) => Boolean(detail.referenceId || detail.referenceType)),
    hasCleanMessageBodies: latestMessages.length > 0 || messages.some((message) => Boolean(message.bodyPreview)),
    hasSenderRecipientUsernames: messages.some((message) => Boolean(message.senderUsername && message.recipientUsername)),
    hasTimestamps: samples.some((sample) => Boolean(sample.latestMessageCreatedDate)) || messages.some((message) => Boolean(message.createdDate)),
    hasReadStatus: messages.some((message) => typeof message.read === "boolean" || Boolean(message.readStatus)),
    hasMedia: messages.some((message) => message.hasMedia === true),
    hasMessageMediaField: messages.some((message) => message.rawKeys.includes("messageMedia") || message.rawKeys.includes("media") || message.rawKeys.includes("attachments")),
    hasConversationStatus: samples.some((sample) => Boolean(sample.conversationStatus)) || details.some((detail) => Boolean(detail.conversationStatus)),
    hasPaginationTotals: conversationSets.some((set) => typeof set.total === "number") || details.some((detail) => typeof detail.pagination.total === "number"),
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
    possibleReferenceIds: unique([
      ...samples.map((sample) => sample.referenceId),
      ...details.map((detail) => detail.referenceId),
    ]).slice(0, 20),
    possibleSubjects: unique([
      ...samples.map((sample) => sample.title),
      ...messages.map((message) => message.subject),
    ]).slice(0, 20),
  };
}

function fieldDiscovery(conversationSets: ConversationSet[], details: DetailSample[]) {
  const samples = conversationSets.flatMap((set) => set.samples);
  const messages = details.flatMap((detail) => detail.messages);
  return {
    conversationListItemKeys: unique(samples.flatMap((sample) => sample.rawKeys)).sort(),
    latestMessageKeys: unique(samples.flatMap((sample) => sample.latestMessageKeys)).sort(),
    conversationDetailTopLevelKeys: unique(details.flatMap((detail) => detail.rawKeys)).sort(),
    messageKeys: unique(messages.flatMap((message) => message.rawKeys)).sort(),
    mediaKeys: unique(messages.flatMap((message) => message.mediaSamples || []).flatMap((sample) => sample.rawKeys)).sort(),
    missingFieldsAcrossDetails: unique(details.flatMap((detail) => detail.missingFields)).sort(),
    suspiciousFieldsAcrossDetails: unique(details.flatMap((detail) => detail.suspiciousFields)).sort(),
  };
}

function payloadExamples(conversationSets: ConversationSet[], details: DetailSample[]) {
  const samples = conversationSets.flatMap((set) => set.samples);
  const messages = details.flatMap((detail) => detail.messages);
  return {
    conversationHeaders: samples.slice(0, 3).map((sample) => ({
      conversationId: sample.conversationId,
      conversationType: sample.conversationType,
      conversationStatus: sample.conversationStatus,
      otherPartyUsername: sample.otherPartyUsername,
      unreadCount: sample.unreadCount,
      latestMessageCreatedDate: sample.latestMessageCreatedDate,
      latestMessagePreview: sample.latestMessagePreview,
      referenceId: sample.referenceId,
      referenceType: sample.referenceType,
      rawKeys: sample.rawKeys,
    })),
    messages: messages.slice(0, 5).map((message) => ({
      messageId: message.messageId,
      senderUsername: message.senderUsername,
      recipientUsername: message.recipientUsername,
      direction: message.direction,
      directionConfidence: message.directionConfidence,
      createdDate: message.createdDate,
      subject: message.subject,
      bodyPreview: message.bodyPreview,
      bodyShape: message.bodyShape,
      read: message.read,
      readStatus: message.readStatus,
      messageStatus: message.messageStatus,
      mediaCount: message.mediaCount,
      rawKeys: message.rawKeys,
    })),
    media: messages.flatMap((message) => message.mediaSamples || []).slice(0, 5),
  };
}

function messageOrderingAnalysis(details: DetailSample[]) {
  return details.map((detail) => ({
    conversationId: detail.conversationId,
    conversationType: detail.conversationType,
    messageCount: detail.messageCount,
    fetchedMessageCount: detail.messages.length,
    observedOrder: detail.orderingAnalysis.observedOrder,
    comparableTimestampCount: detail.orderingAnalysis.comparableTimestampCount,
    stableMessageIds: detail.orderingAnalysis.stableMessageIds,
    duplicateMessageIds: detail.orderingAnalysis.duplicateMessageIds,
    duplicateBodyPreviews: detail.orderingAnalysis.duplicateBodyPreviews,
    pagination: detail.pagination,
  }));
}

function correlationAnalysis(conversationSets: ConversationSet[], details: DetailSample[]) {
  const cov = coverage(conversationSets, details);
  const hints = correlationHints(conversationSets, details);
  const messages = details.flatMap((detail) => detail.messages);
  const textForExtraction = messages.map((message) => [message.subject, message.bodyPreview].filter(Boolean).join(" ")).join(" ");
  const orderNumberCandidates = uniqueText(textForExtraction.match(/\b\d{2}-\d{5}-\d{5}\b/g) || []).slice(0, 10);
  const itemIdCandidates = uniqueText(textForExtraction.match(/\b\d{12}\b/g) || []).slice(0, 10);
  const returnSignalObserved = /\breturn|refund|case|defect|not as described|arrived damaged\b/i.test(textForExtraction);
  return {
    strongCorrelation: [
      cov.hasListingReferences ? "listing/reference id from Commerce Message payload" : "",
      cov.hasOtherPartyUsernames ? "otherPartyUsername / senderUsername / recipientUsername" : "",
      orderNumberCandidates.length ? "explicit eBay order-number pattern in message text preview" : "",
    ].filter(Boolean),
    weakCorrelation: [
      hints.possibleSubjects.length ? "conversation title or message subject text" : "",
      itemIdCandidates.length ? "item/listing-like numeric candidates extracted from previews" : "",
      returnSignalObserved ? "return/refund language in message preview" : "",
    ].filter(Boolean),
    directApiFields: {
      listingReferenceObserved: cov.hasListingReferences,
      usernameObserved: cov.hasOtherPartyUsernames || cov.hasSenderRecipientUsernames,
      orderIdObserved: orderNumberCandidates.length > 0,
      returnIdObserved: false,
    },
    extractedCandidates: {
      orderNumbers: orderNumberCandidates,
      itemIds: itemIdCandidates,
      buyerUsernames: hints.possibleBuyerUsernames,
      referenceIds: hints.possibleReferenceIds,
    },
    orderCorrelationFeasibility: cov.hasListingReferences && (cov.hasOtherPartyUsernames || cov.hasSenderRecipientUsernames)
      ? "strong: join reference/listing id plus username to ebay_order_lines/ebay_orders and buyer history"
      : "partial: needs deterministic extraction or buyer-history lookup from subject/body/usernames",
    returnCorrelationFeasibility: returnSignalObserved && (cov.hasOtherPartyUsernames || cov.hasSenderRecipientUsernames)
      ? "weak-to-moderate: use username/order/listing links, then join to ebay_return_cases; Commerce Message payload does not expose a return id in this probe"
      : "weak: normal Commerce Message conversations should be linked to returns through orders/buyer context or Post-Order return sync, not trusted as direct return identity",
    trustedDirectlyFromApi: [
      "conversationId",
      "messageId when present",
      "senderUsername/recipientUsername when present",
      "createdDate timestamps when present",
      "conversationStatus/unreadCount/readStatus when present",
      "listing reference when present",
    ],
    stillNeedsDeterministicExtraction: [
      "order number when not provided as a structured field",
      "return case id",
      "SKU/inventory identity beyond listing reference",
      "supplemental marketplace notification links, if needed for audit",
    ],
  };
}

function canonicalConversationAssessment(conversationSets: ConversationSet[], details: DetailSample[]) {
  const cov = coverage(conversationSets, details);
  const messages = details.flatMap((detail) => detail.messages);
  const detailDirections = messages.map((message) => message.direction);
  const reliableDirections = messages.filter((message) =>
    message.direction && message.direction !== "unknown" && message.directionConfidence !== "weak" && message.directionConfidence !== "unknown"
  ).length;
  const bodyLooksClean = messages.some((message) => Boolean(message.bodyPreview)) &&
    !messages.some((message) => message.bodyShape?.hasLikelyEbayTemplateText);
  const orderingStable = details.length > 0 && details.every((detail) =>
    detail.orderingAnalysis.observedOrder !== "mixed_or_unknown" &&
    detail.orderingAnalysis.stableMessageIds &&
    detail.pagination.duplicateMessageIdsAcrossFetchedPages.length === 0
  );
  const orderCorrelation = cov.hasListingReferences && (cov.hasOtherPartyUsernames || cov.hasSenderRecipientUsernames);
  return {
    supportsCanonicalInbox: cov.hasConversationIds && cov.hasTimestamps && cov.hasConversationStatus,
    supportsCleanChatTimeline: cov.hasSenderRecipientUsernames && cov.hasTimestamps && bodyLooksClean,
    supportsReliableDirection: messages.length > 0 && reliableDirections === messages.length,
    supportsUnreadState: cov.hasUnreadCounts || cov.hasReadStatus,
    supportsMessageOrdering: orderingStable,
    supportsMedia: cov.hasMedia || cov.hasMessageMediaField,
    supportsOrderCorrelation: orderCorrelation,
    supportsReturnCorrelation: false,
    externalEmailRequiredForCanonicalChat: false,
    caveats: [
      !messages.length ? "No detail messages were fetched in this run; use includeDetails or conversationId for canonical timeline validation." : "",
      detailDirections.includes("unknown") ? "Some message directions are unknown without otherPartyUsername or stored seller username." : "",
      !cov.hasMedia ? "No actual media object was observed in the sampled messages; media field support may need a conversation with attachments." : "",
      !orderCorrelation ? "Order correlation needs listing reference plus username, or deterministic extraction fallback." : "",
      "Return correlation remains a Post-Order Return API concern unless a normal conversation can be linked to an order/return context.",
    ].filter(Boolean),
  };
}

function proposedCanonicalDataContract() {
  return {
    conversation: {
      source: "eBay Commerce Message API getConversations/getConversation",
      identity: ["ebay_conversation_id", "conversation_type"],
      fields: [
        "conversation_status",
        "title",
        "other_party_username",
        "reference_id",
        "reference_type",
        "unread_count",
        "latest_message_created_at",
        "latest_message_preview",
        "last_synced_at",
        "raw_summary",
      ],
    },
    conversation_message: {
      source: "eBay Commerce Message API getConversation.messages[]",
      identity: ["ebay_conversation_id", "ebay_message_id"],
      fields: [
        "sender_username",
        "recipient_username",
        "direction",
        "direction_confidence",
        "subject",
        "message_body",
        "body_shape",
        "read_status",
        "created_at_ebay",
        "has_media",
        "dedupe_hash",
        "raw_message",
      ],
    },
    message_direction: {
      inbound: "senderUsername equals otherPartyUsername",
      outbound: "recipientUsername equals otherPartyUsername",
      platform: "conversation_type is FROM_EBAY or platform participant fields prove eBay-authored content",
      unknown: "sender/recipient/other-party data is insufficient",
    },
    message_participant: {
      fields: ["username", "role", "source_field", "first_seen_at", "last_seen_at"],
      note: "Store seller account username separately so single-conversation probes can infer direction even without list context.",
    },
    listing_reference: {
      fields: ["reference_id", "reference_type", "listing_id", "item_id"],
      correlationUse: "Join to ebay_order_lines, ebay_inventory_links, and buyer history with username/time filters.",
    },
    conversation_status: {
      fields: ["conversation_status", "read_status", "unread_count"],
      note: "Use only native eBay read state for eBay conversations.",
    },
    conversation_latest_activity: {
      fields: ["latest_message_id", "latest_message_created_at", "latest_message_preview", "latest_sender_username"],
      note: "Use eBay timestamps for inbox ordering and sync watermarks.",
    },
  };
}

function readinessAssessment(conversationSets: ConversationSet[], details: DetailSample[]) {
  const assessment = canonicalConversationAssessment(conversationSets, details);
  const canProceed = Boolean(
    assessment.supportsCanonicalInbox &&
    assessment.supportsCleanChatTimeline &&
    assessment.supportsUnreadState &&
    assessment.supportsMessageOrdering
  );
  return {
    canProceedToCanonicalSchemaDesign: canProceed,
    needsMoreApiInvestigationFirst: !canProceed,
    recommendedNextStep: canProceed
      ? "Step 5F.6E - design canonical eBay conversation schema and migrations from observed payload fields."
      : "Run this probe against multi-message active conversations, known buyer usernames, and attachment/return-adjacent cases before final schema design.",
    blockersOrOpenQuestions: [
      !assessment.supportsReliableDirection ? "Confirm direction with otherPartyUsername or stored seller username across multi-message buyer/seller threads." : "",
      !assessment.supportsMedia ? "Find at least one conversation with media to validate messageMedia shape." : "",
      !assessment.supportsOrderCorrelation ? "Confirm listing reference and username correlation against existing ebay_order_lines/ebay_orders." : "",
      "Return-case messages should still be validated through the Post-Order Return API path, not assumed from Commerce Message conversations.",
    ].filter(Boolean),
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
    `Conversation detail pagination probes fetch at most ${DETAIL_MESSAGE_LIMIT} first-page messages and ${DETAIL_SECOND_PAGE_LIMIT} second-page messages per conversation.`,
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
    for (const suspicious of detail.suspiciousFields) warnings.push(`${detail.conversationId}: ${suspicious}`);
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
    const emptyDetails: DetailSample[] = [];
    return {
      ok: false,
      mode: "probe",
      environment: ebayEnvironment(),
      scopeRequested,
      tokenRefresh: tokenResult.diagnostic,
      conversations: emptySet,
      conversationSets: [emptySet],
      fieldCoverage: coverage([emptySet], emptyDetails),
      fieldDiscovery: fieldDiscovery([emptySet], emptyDetails),
      correlationHints: correlationHints([emptySet], emptyDetails),
      correlationAnalysis: correlationAnalysis([emptySet], emptyDetails),
      canonicalConversationAssessment: canonicalConversationAssessment([emptySet], emptyDetails),
      proposedCanonicalDataContract: proposedCanonicalDataContract(),
      readinessAssessment: readinessAssessment([emptySet], emptyDetails),
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
      .flatMap((set) => set.samples.map((sample) => ({ conversationId: sample.conversationId, conversationType: set.conversationType, sample })))
      .slice(0, DETAIL_CONVERSATION_MAX);
    for (const target of detailTargets) {
      details.push(await fetchDetail(token, target.conversationId, target.conversationType, target.sample));
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
    fieldDiscovery: fieldDiscovery(conversationSets, details),
    payloadExamples: payloadExamples(conversationSets, details),
    messageOrderingAnalysis: messageOrderingAnalysis(details),
    correlationHints: correlationHints(conversationSets, details),
    correlationAnalysis: correlationAnalysis(conversationSets, details),
    canonicalConversationAssessment: canonicalConversationAssessment(conversationSets, details),
    proposedCanonicalDataContract: proposedCanonicalDataContract(),
    readinessAssessment: readinessAssessment(conversationSets, details),
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
