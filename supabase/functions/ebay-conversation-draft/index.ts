import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildEbayConversationContext,
  EbayConversationContextError,
  resolveEbayConversation,
} from "../_shared/ebay-conversation-context.ts";

type ServiceClient = ReturnType<typeof createClient>;
type Mode = "view" | "generate" | "regenerate" | "improve" | "save_edit" | "discard" | "approve" | "unapprove" | "send";

type Input = {
  mode: Mode;
  conversationId: string | null;
  ebayConversationId: string | null;
  conversationType: string | null;
  targetMessageId: string | null;
  draftId: string | null;
  draftText: string | null;
  improvementInstructions: string | null;
  operatorNotes: string | null;
  approvalNotes: string | null;
  manualComposer: boolean;
  sendConfirmed: boolean;
};

type GroundingFact = {
  id: string;
  label: string;
  buyer_facing: boolean;
  value: string | number | boolean | null;
};

type DraftOutput = {
  draft_text: string;
  tone: string;
  summary_of_intent: string;
  facts_used: string[];
  missing_context: string[];
  safety_warnings: string[];
  confidence: number;
};

const GENERATOR_NAME = "ebay_conversation_response_drafter";
const GENERATOR_VERSION = "v1";
const PROMPT_VERSION_DEFAULT = "ebay-conversation-draft-v2-target-message";
const MANUAL_PROMPT_VERSION = "manual-composer-v1";
const DEFAULT_MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
const OPENAI_TIMEOUT_MS = 45000;
const MAX_DRAFT_TEXT_CHARS = 4000;
const MAX_OPERATOR_TEXT_CHARS = 4000;
const EBAY_MAX_MESSAGE_TEXT_CHARS = 2000;
const TRANSIENT_OPENAI_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const ACTIVE_SEND_STATUSES = new Set(["created", "ready_to_send", "sending"]);

class DraftError extends Error {
  code: string;
  status: number;
  phase: string;
  transient: boolean;
  details: Record<string, unknown>;

  constructor(code: string, options: {
    status?: number;
    phase?: string;
    transient?: boolean;
    message?: string;
    details?: Record<string, unknown>;
  } = {}) {
    super(options.message || code);
    this.name = "DraftError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "draft";
    this.transient = options.transient === true;
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
  if (!value) throw new DraftError("configuration_error", { phase: "configuration" });
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

function authenticatedClient(accessToken: string) {
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(requiredEnv("SUPABASE_URL"), anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient) {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new DraftError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null, accessToken };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new DraftError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new DraftError("configuration_error", { phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new DraftError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null, accessToken };
}

function text(value: unknown, maxLength = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeBodyText(value: unknown, maxLength = MAX_DRAFT_TEXT_CHARS) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxLength);
}

function stringOrNull(value: unknown, maxLength = 240) {
  const cleaned = text(value, maxLength);
  return cleaned || null;
}

async function parseInput(req: Request): Promise<Input> {
  const body = await req.json().catch(() => ({}));
  const rawMode = stringOrNull(body?.mode, 80) || "view";
  if (!["view", "generate", "regenerate", "improve", "save_edit", "discard", "approve", "unapprove", "send"].includes(rawMode)) {
    throw new DraftError("invalid_mode", { status: 400, phase: "input" });
  }
  return {
    mode: rawMode as Mode,
    conversationId: stringOrNull(body?.conversationId || body?.conversation_id, 120),
    ebayConversationId: stringOrNull(body?.ebayConversationId || body?.ebay_conversation_id, 180),
    conversationType: stringOrNull(body?.conversationType || body?.conversation_type, 80),
    targetMessageId: stringOrNull(body?.targetMessageId || body?.target_message_id, 120),
    draftId: stringOrNull(body?.draftId || body?.draft_id, 120),
    draftText: typeof body?.draftText === "string" || typeof body?.draft_text === "string"
      ? safeBodyText(body?.draftText || body?.draft_text, MAX_OPERATOR_TEXT_CHARS)
      : null,
    improvementInstructions: stringOrNull(body?.improvementInstructions || body?.improvement_instructions, 1000),
    operatorNotes: stringOrNull(body?.operatorNotes || body?.operator_notes, 1000),
    approvalNotes: stringOrNull(body?.approvalNotes || body?.approval_notes || body?.operatorNotes || body?.operator_notes, 1000),
    manualComposer: body?.manualComposer === true || body?.manual_composer === true,
    sendConfirmed: body?.sendConfirmed === true || body?.send_confirmed === true,
  };
}

function promptVersion() {
  return Deno.env.get("EBAY_CONVERSATION_DRAFT_PROMPT_VERSION")?.trim() || PROMPT_VERSION_DEFAULT;
}

function modelName() {
  return Deno.env.get("OPENAI_EBAY_CONVERSATION_DRAFT_MODEL")?.trim() ||
    Deno.env.get("OPENAI_EMAIL_RESPONSE_DRAFT_MODEL")?.trim() ||
    Deno.env.get("OPENAI_EMAIL_CLASSIFIER_MODEL")?.trim() ||
    "gpt-4.1-mini";
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  const bodyText = await res.text();
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return { raw: bodyText.slice(0, 1000) };
  }
}

function safeMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return text(payload, 500) || "No response body.";
  const record = payload as Record<string, any>;
  const parts = [
    record.message,
    record.longMessage,
    record.error,
    record.error_description,
    record.detail,
    Array.isArray(record.errors) ? record.errors.map((item) => safeMessage(item)).join(" ") : "",
  ].map((item) => text(item, 500)).filter(Boolean);
  return parts.join(" ") || JSON.stringify(payload).slice(0, 1000);
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
    throw new DraftError("missing_ebay_oauth_secret", { status: 500, phase: "oauth" });
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
    throw new DraftError("ebay_oauth_refresh_failed", {
      status: 502,
      phase: "oauth",
      message: safeMessage(payload),
      details: { provider_response: { status: res.status, payload } },
    });
  }

  const token = text(payload.access_token, 4000);
  if (!token) throw new DraftError("ebay_oauth_missing_access_token", { status: 502, phase: "oauth" });
  return token;
}

async function ebayPost(token: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${ebayApiBase()}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseResponse(res);
  return {
    ok: res.ok,
    status: res.status,
    payload,
    headers: {
      correlation_id: res.headers.get("x-ebay-c-request-id") || res.headers.get("x-ebay-request-id") || null,
    },
  };
}

function parseObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : [];
}

function latestMessage(messages: Array<Record<string, any>>) {
  return messages[messages.length - 1] || null;
}

function latestInboundMessage(messages: Array<Record<string, any>>) {
  return [...messages].reverse().find((message) => String(message.direction || "").toLowerCase() === "inbound") || null;
}

function previousDraftTargetMessageId(previousDraft: Record<string, any> | null) {
  if (!previousDraft) return null;
  const inputSnapshot = parseObject(previousDraft.input_snapshot);
  const draftRequest = parseObject(inputSnapshot.draft_request);
  const groundingSummary = parseObject(previousDraft.grounding_summary);
  const targetMessage = parseObject(groundingSummary.target_message || inputSnapshot.target_message);
  return text(previousDraft.target_message_id || draftRequest.target_message_id || targetMessage.id, 120) || null;
}

function publicApproval(row: Record<string, any>) {
  return {
    id: row.id,
    conversation_id: row.conversation_id || null,
    target_message_id: row.target_message_id || null,
    draft_id: row.draft_id || null,
    approval_status: row.approval_status || "approval_removed",
    approved_by: row.approved_by || null,
    approved_by_email: row.approved_by_email || null,
    approved_at: row.approved_at || null,
    approval_notes: row.approval_notes || null,
    removed_by: row.removed_by || null,
    removed_by_email: row.removed_by_email || null,
    removed_at: row.removed_at || null,
    removal_notes: row.removal_notes || null,
    previous_approval_id: row.previous_approval_id || null,
    idempotency_key: row.idempotency_key || null,
    created_at: row.created_at || null,
  };
}

function latestApprovalEvent(approvals: Array<Record<string, any>> = []) {
  return approvals
    .slice()
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))[0] || null;
}

function publicApprovalState(
  approvals: Array<Record<string, any>> = [],
  staleness: Record<string, unknown> | null = null,
  draft: Record<string, any> | null = null,
) {
  const history = approvals
    .slice()
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))
    .map(publicApproval);
  const latest = history[0] || null;
  const isApproved = latest?.approval_status === "approved";
  const isCurrent = draft?.is_current === true && !draft?.discarded_at;
  const validationStatus = String(draft?.validation_status || "");
  const validationReady = validationStatus === "valid" || validationStatus === "warning";
  const isStale = staleness?.is_stale === true || staleness?.isStale === true;
  const isSent = String(draft?.draft_status || "").toLowerCase() === "sent";

  return {
    status: isApproved ? "approved" : latest ? "approval_removed" : "not_approved",
    is_approved: isApproved,
    ready_to_send: isApproved && isCurrent && validationReady && !isStale && !isSent,
    latest_approval_id: isApproved ? latest.id : null,
    approved_by: isApproved ? latest.approved_by : null,
    approved_by_email: isApproved ? latest.approved_by_email : null,
    approved_at: isApproved ? latest.approved_at : null,
    approval_notes: isApproved ? latest.approval_notes : null,
    idempotency_key: isApproved ? latest.idempotency_key : null,
    removed_by: !isApproved && latest ? latest.removed_by : null,
    removed_by_email: !isApproved && latest ? latest.removed_by_email : null,
    removed_at: !isApproved && latest ? latest.removed_at : null,
    removal_notes: !isApproved && latest ? latest.removal_notes : null,
    history,
  };
}

function publicSendAttempt(row: Record<string, any>) {
  return {
    id: row.id || null,
    conversation_id: row.conversation_id || null,
    target_message_id: row.target_message_id || null,
    draft_id: row.draft_id || null,
    approval_id: row.approval_id || null,
    attempt_status: row.attempt_status || "created",
    provider: row.provider || "ebay_commerce_message",
    provider_message_id: row.provider_message_id || null,
    provider_correlation_id: row.provider_correlation_id || null,
    idempotency_key: row.idempotency_key || null,
    attempt_sequence: Number(row.attempt_sequence || 1),
    duplicate_of_attempt_id: row.duplicate_of_attempt_id || null,
    error_message: row.error_message || null,
    provider_response: parseObject(row.provider_response),
    metadata: parseObject(row.metadata),
    sent_at: row.sent_at || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function publicSendState(attempts: Array<Record<string, any>> = []) {
  const history = attempts
    .slice()
    .sort((left, right) =>
      Number(right.attempt_sequence || 0) - Number(left.attempt_sequence || 0) ||
      String(right.created_at || "").localeCompare(String(left.created_at || ""))
    )
    .map(publicSendAttempt);
  const succeeded = history.find((attempt) => attempt.attempt_status === "succeeded") || null;
  const latest = history[0] || null;
  const status = succeeded ? "sent" : latest?.attempt_status || "not_sent";
  return {
    status,
    is_sent: Boolean(succeeded),
    latest_attempt_id: latest?.id || null,
    latest_attempt_status: latest?.attempt_status || null,
    latest_error_message: latest?.error_message || null,
    provider_message_id: succeeded?.provider_message_id || null,
    provider_correlation_id: succeeded?.provider_correlation_id || latest?.provider_correlation_id || null,
    sent_at: succeeded?.sent_at || null,
    history,
  };
}

function draftHasManualSendBypass(draft: Record<string, any> | null) {
  if (!draft?.id) return false;
  if (String(draft.source_mode || "").toLowerCase() === "operator_edit") return true;
  const inputSnapshot = parseObject(draft.input_snapshot);
  const draftRequest = parseObject(inputSnapshot.draft_request);
  const previousDraft = parseObject(inputSnapshot.previous_draft);
  return draftRequest.manual_send_bypass === true || previousDraft.manual_send_bypass === true;
}

function draftAllowsManualSend(draft: Record<string, any> | null) {
  return draftHasManualSendBypass(draft) && String(draft?.draft_status || "").toLowerCase() !== "sent";
}

async function loadTargetMessage(
  supabase: ServiceClient,
  conversationId: string,
  targetMessageId: string,
) {
  const { data, error } = await supabase
    .from("ebay_conversation_messages")
    .select("id, conversation_id, ebay_message_id, direction, sender_username, recipient_username, created_at_ebay, subject, message_body, message_body_preview, has_media, media_count, created_at")
    .eq("id", targetMessageId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw new DraftError("target_message_lookup_failed", { phase: "draft_input" });
  return data as Record<string, any> | null;
}

async function loadLatestInboundMessage(supabase: ServiceClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_messages")
    .select("id, conversation_id, ebay_message_id, direction, sender_username, recipient_username, created_at_ebay, subject, message_body, message_body_preview, has_media, media_count, created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("created_at_ebay", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new DraftError("latest_inbound_message_lookup_failed", { phase: "draft_input" });
  return data as Record<string, any> | null;
}

async function resolveTargetMessage(
  supabase: ServiceClient,
  conversationId: string,
  context: Record<string, any>,
  input: Input,
  previousDraft: Record<string, any> | null,
) {
  const messages = safeArray(context.messages) as Array<Record<string, any>>;
  const requestedTargetId = input.targetMessageId || previousDraftTargetMessageId(previousDraft);
  const target = requestedTargetId
    ? messages.find((message) => String(message.id || "") === requestedTargetId) ||
      await loadTargetMessage(supabase, conversationId, requestedTargetId)
    : latestInboundMessage(messages);

  if (!target?.id) {
    throw new DraftError(requestedTargetId ? "target_message_not_found" : "target_message_required", { status: 400, phase: "draft_input" });
  }
  if (String(target.direction || "").toLowerCase() !== "inbound") {
    throw new DraftError("target_message_must_be_inbound", { status: 400, phase: "draft_input" });
  }
  return target;
}

function effectiveClassification(row: Record<string, any> | null) {
  if (!row?.id) return null;
  const override = parseObject(row.operator_override_payload);
  const topicTags = safeArray(override.topic_tags || row.topic_tags).map((item) => text(item, 80)).filter(Boolean);
  const buyerFlags = safeArray(override.buyer_flags || row.buyer_flags).map((item) => text(item, 80)).filter(Boolean);
  const riskFlags = safeArray(override.risk_flags || row.risk_flags).map((item) => text(item, 80)).filter(Boolean);
  return {
    id: row.id,
    priority: text(override.priority || row.priority, 40) || "normal",
    response_need: text(override.response_need || row.response_need, 60) || "reply_later",
    topic_tags: topicTags,
    buyer_flags: buyerFlags,
    risk_flags: riskFlags,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    summary: text(override.summary || row.summary, 280),
    reasoning_summary: text(override.reasoning_summary || row.reasoning_summary, 280),
    recommended_action: text(override.recommended_action || row.recommended_action, 180),
    review_state: row.review_state || "pending_review",
    has_operator_override: Object.keys(override).length > 0,
    latest_message_id: row.latest_message_id || null,
    latest_ebay_message_id: row.latest_ebay_message_id || null,
    input_hash: row.input_hash || null,
    context_hash: row.context_hash || null,
    created_at: row.created_at || null,
  };
}

function compactMessageForDraft(message: Record<string, any> | null) {
  if (!message) return null;
  return {
    id: message.id || null,
    ebay_message_id: message.ebay_message_id || null,
    direction: message.direction || null,
    sender_username: message.sender_username || null,
    recipient_username: message.recipient_username || null,
    created_at_ebay: message.created_at_ebay || null,
    subject: message.subject || null,
    body: safeBodyText(message.message_body || message.message_body_preview, 2200),
    has_media: message.has_media === true,
    media_count: Number(message.media_count || 0),
  };
}

function factId(parts: Array<string | null | undefined>) {
  return parts.map((part) => text(part, 120).replace(/[^a-zA-Z0-9_.:-]+/g, "_")).filter(Boolean).join(":");
}

function pushFact(facts: GroundingFact[], id: string, label: string, value: unknown, buyerFacing = true) {
  const normalized = typeof value === "number" || typeof value === "boolean" ? value : text(value, 500);
  if (normalized === "" || normalized === null || normalized === undefined) return;
  if (facts.some((fact) => fact.id === id)) return;
  facts.push({ id, label, value: normalized, buyer_facing: buyerFacing });
}

function buildGrounding(context: Record<string, any>) {
  const facts: GroundingFact[] = [];
  const missing = new Set<string>();
  const orders = safeArray(context.matched_orders) as Array<Record<string, any>>;
  const orderLines = safeArray(context.matched_order_lines) as Array<Record<string, any>>;
  const returns = safeArray(context.matched_returns) as Array<Record<string, any>>;
  const inventory = safeArray(context.inventory_listing_context) as Array<Record<string, any>>;
  const history = parseObject(context.buyer_history_summary);
  const linkConfidence = parseObject(context.link_confidence);
  const buyer = parseObject(context.buyer);

  pushFact(facts, "link_confidence", "Link confidence", linkConfidence.level || "none", false);
  pushFact(facts, "buyer:username", "Matched buyer username", buyer.username, false);
  pushFact(facts, "buyer:confidence", "Buyer match confidence", buyer.confidence, false);

  if (history.prior_order_count !== null && history.prior_order_count !== undefined) {
    pushFact(facts, "buyer_history:prior_order_count", "Buyer prior order count", history.prior_order_count, false);
  }
  if (history.return_count !== null && history.return_count !== undefined) {
    pushFact(facts, "buyer_history:return_count", "Buyer return count", history.return_count, false);
  }
  if (history.gross_value !== null && history.gross_value !== undefined) {
    pushFact(facts, "buyer_history:gross_value", "Buyer gross purchase value", history.gross_value, false);
  }
  if (history.retained_value !== null && history.retained_value !== undefined) {
    pushFact(facts, "buyer_history:retained_value", "Buyer retained purchase value", history.retained_value, false);
  }
  if (history.average_order_value !== null && history.average_order_value !== undefined) {
    pushFact(facts, "buyer_history:average_order_value", "Buyer average order value", history.average_order_value, false);
  }

  if (!orders.length) missing.add("matched order unavailable");
  for (const order of orders.slice(0, 8)) {
    const orderKey = text(order.order_number || order.id, 120) || "unknown_order";
    pushFact(facts, factId(["order", orderKey, "order_number"]), `Matched order ${orderKey}`, order.order_number);
    pushFact(facts, factId(["order", orderKey, "status"]), `Order ${orderKey} status`, order.status);
    pushFact(facts, factId(["order", orderKey, "sale_date"]), `Order ${orderKey} sale date`, order.sale_date);
    pushFact(facts, factId(["order", orderKey, "paid_on_date"]), `Order ${orderKey} paid date`, order.paid_on_date);
    pushFact(facts, factId(["order", orderKey, "ship_by_date"]), `Order ${orderKey} ship-by date`, order.ship_by_date);
    pushFact(facts, factId(["order", orderKey, "shipped_on_date"]), `Order ${orderKey} shipped date`, order.shipped_on_date);
    pushFact(facts, factId(["order", orderKey, "tracking_number"]), `Order ${orderKey} tracking number`, order.tracking_number);
    pushFact(facts, factId(["order", orderKey, "shipping_service"]), `Order ${orderKey} shipping service`, order.shipping_service);
    pushFact(facts, factId(["order", orderKey, "carrier"]), `Order ${orderKey} carrier`, order.carrier);
    pushFact(facts, factId(["order", orderKey, "shipment_status"]), `Order ${orderKey} shipment status`, order.shipment_status);
    pushFact(facts, factId(["order", orderKey, "label_status"]), `Order ${orderKey} label status`, order.label_status, false);
    pushFact(facts, factId(["order", orderKey, "ebay_shipment_id"]), `Order ${orderKey} eBay shipment id`, order.ebay_shipment_id, false);
    const safeLabelMetadata = parseObject(order.safe_label_metadata);
    pushFact(facts, factId(["order", orderKey, "trackingNumber"]), `Order ${orderKey} label tracking number`, safeLabelMetadata.trackingNumber);
    pushFact(facts, factId(["order", orderKey, "shippingBarcodeNumber"]), `Order ${orderKey} shipping barcode number`, safeLabelMetadata.shippingBarcodeNumber, false);
    pushFact(facts, factId(["order", orderKey, "shipmentStatus"]), `Order ${orderKey} label shipment status`, safeLabelMetadata.shipmentStatus);
    pushFact(facts, factId(["order", orderKey, "deliveryStatus"]), `Order ${orderKey} delivery status`, safeLabelMetadata.deliveryStatus);
    if (!order.tracking_number && !safeLabelMetadata.trackingNumber) missing.add(`tracking number unavailable for order ${orderKey}`);
    if (!order.shipped_on_date) missing.add(`shipped date unavailable for order ${orderKey}`);
  }

  if (!orderLines.length) missing.add("matched order line unavailable");
  for (const line of orderLines.slice(0, 8)) {
    const lineKey = text(line.order_number || line.item_number || line.id, 120) || "unknown_line";
    pushFact(facts, factId(["order_line", lineKey, "item_title"]), `Order line ${lineKey} item title`, line.item_title);
    pushFact(facts, factId(["order_line", lineKey, "item_number"]), `Order line ${lineKey} item number`, line.item_number);
    pushFact(facts, factId(["order_line", lineKey, "line_status"]), `Order line ${lineKey} status`, line.line_status);
    pushFact(facts, factId(["order_line", lineKey, "quantity"]), `Order line ${lineKey} quantity`, line.quantity);
  }

  if (!returns.length) missing.add("return context unavailable");
  for (const returnCase of returns.slice(0, 6)) {
    const returnKey = text(returnCase.ebay_return_id || returnCase.order_number || returnCase.id, 120) || "unknown_return";
    pushFact(facts, factId(["return", returnKey, "id"]), `Return ${returnKey}`, returnCase.ebay_return_id);
    pushFact(facts, factId(["return", returnKey, "status"]), `Return ${returnKey} status`, returnCase.status);
    pushFact(facts, factId(["return", returnKey, "reason"]), `Return ${returnKey} reason`, returnCase.return_reason);
    pushFact(facts, factId(["return", returnKey, "opened_at"]), `Return ${returnKey} opened date`, returnCase.opened_at);
    pushFact(facts, factId(["return", returnKey, "closed_at"]), `Return ${returnKey} closed date`, returnCase.closed_at);
    pushFact(facts, factId(["return", returnKey, "tracking"]), `Return ${returnKey} tracking`, returnCase.return_tracking_number);
  }

  for (const link of inventory.slice(0, 6)) {
    const inventoryKey = text(link.listing_id || link.offer_id || link.sku || link.item_type_id, 120) || "unknown_listing";
    pushFact(facts, factId(["inventory", inventoryKey, "listing_id"]), `Inventory listing ${inventoryKey}`, link.listing_id);
    pushFact(facts, factId(["inventory", inventoryKey, "status"]), `Inventory listing ${inventoryKey} status`, link.status, false);
  }

  if (String(linkConfidence.level || "none") === "none" || String(linkConfidence.level || "none") === "weak") {
    missing.add("strong link confidence unavailable");
  }

  return {
    facts,
    missing_context_options: [...missing].slice(0, 40),
  };
}

function shippingQuestionLikely(input: Record<string, any>) {
  const targetMessage = input.target_message || input.latest_inbound_message || {};
  const haystack = stableStringify([
    targetMessage.subject,
    targetMessage.body,
    input.classification?.topic_tags,
  ]).toLowerCase();
  return /\b(ship|shipped|shipping|tracking|track|where is|where's|delivery|delivered|arrive|order status)\b/.test(haystack);
}

function buildFallbackDraft(input: Record<string, any>, reason: string): DraftOutput {
  const grounding = input.grounding || {};
  const facts = safeArray(grounding.facts) as GroundingFact[];
  const findFact = (suffix: string) => facts.find((fact) => fact.id.endsWith(suffix));
  const shippedDate = findFact(":shipped_on_date");
  const tracking = findFact(":tracking_number");
  const factsUsed = new Set<string>();
  const missing = new Set<string>(safeArray(grounding.missing_context_options).map((item) => text(item, 180)).filter(Boolean));
  const operatorDraft = safeBodyText(input.operator_draft, MAX_DRAFT_TEXT_CHARS);

  if (input.draft_request?.mode === "improve" && operatorDraft) {
    return {
      draft_text: operatorDraft,
      tone: "operator_written_needs_review",
      summary_of_intent: "Preserve the operator-written buyer reply because the automatic improvement was blocked by validation.",
      facts_used: [],
      missing_context: [...missing].slice(0, 8),
      safety_warnings: [`improve fallback used: ${reason}; kept operator draft instead of replacing it with a generic response`],
      confidence: 0.45,
    };
  }

  let draftText = "Thank you for reaching out. We will review the details connected to your message and follow up as soon as possible.";
  if (shippingQuestionLikely(input)) {
    if (tracking?.value) {
      const shippedPart = shippedDate?.value ? ` The order information available to us shows the item was shipped on ${shippedDate.value}.` : "";
      draftText = `Thank you for reaching out.${shippedPart} The tracking number available for the order is ${tracking.value}. We will review the details and follow up if anything else is needed.`;
      if (shippedDate?.id && shippedDate.value) factsUsed.add(shippedDate.id);
      factsUsed.add(tracking.id);
    } else if (shippedDate?.value) {
      draftText = `Thank you for reaching out. The order information available to us shows the item was shipped on ${shippedDate.value}. I do not currently see tracking information available here, but we can look into it and follow up.`;
      factsUsed.add(shippedDate.id);
      missing.add("tracking number unavailable");
    } else {
      draftText = "Thank you for reaching out. We will look into the order details and follow up as soon as possible.";
    }
  }

  return {
    draft_text: draftText,
    tone: "professional_friendly",
    summary_of_intent: "Provide a conservative buyer-facing acknowledgement while the operator verifies details.",
    facts_used: [...factsUsed],
    missing_context: [...missing].slice(0, 8),
    safety_warnings: [`safe fallback used: ${reason}`],
    confidence: 0.55,
  };
}

function buildDraftInput(
  context: Record<string, any>,
  classification: Record<string, any> | null,
  targetMessage: Record<string, any>,
  mode: Mode,
  operatorDraftText: string | null,
  improvementInstructions: string | null,
  previousDraft: Record<string, any> | null,
  manualSendBypass: boolean,
  version: string,
) {
  const messages = safeArray(context.messages) as Array<Record<string, any>>;
  const grounding = buildGrounding(context);
  const manualRewriteOnly = mode === "improve" && manualSendBypass && Boolean(safeBodyText(operatorDraftText, MAX_DRAFT_TEXT_CHARS));
  const objectiveContext = manualRewriteOnly
    ? {
      buyer: context.buyer || {},
      matched_orders: [],
      matched_order_lines: [],
      matched_returns: [],
      buyer_history_summary: context.buyer_history_summary || null,
      buyer_value_line_breakdown: safeArray(context.buyer_value_line_breakdown),
      inventory_listing_context: [],
      link_confidence: context.link_confidence || {},
      context_warnings: [],
    }
    : {
      buyer: context.buyer || {},
      matched_orders: safeArray(context.matched_orders),
      matched_order_lines: safeArray(context.matched_order_lines),
      matched_returns: safeArray(context.matched_returns),
      buyer_history_summary: context.buyer_history_summary || null,
      buyer_value_line_breakdown: safeArray(context.buyer_value_line_breakdown),
      inventory_listing_context: safeArray(context.inventory_listing_context),
      link_confidence: context.link_confidence || {},
      context_warnings: safeArray(context.warnings),
    };
  return {
    conversation: context.conversation || {},
    target_message: manualRewriteOnly ? null : compactMessageForDraft(targetMessage),
    latest_message: manualRewriteOnly ? null : compactMessageForDraft(latestMessage(messages)),
    latest_inbound_message: manualRewriteOnly ? null : compactMessageForDraft(latestInboundMessage(messages)),
    timeline: manualRewriteOnly ? [] : messages.slice(-60).map(compactMessageForDraft),
    classification: classification ? effectiveClassification(classification) : null,
    objective_context: objectiveContext,
    grounding,
    operator_draft: operatorDraftText || null,
    operator_instructions: improvementInstructions || null,
    previous_draft: previousDraft
      ? {
        id: previousDraft.id || null,
        target_message_id: previousDraft.target_message_id || previousDraftTargetMessageId(previousDraft),
        draft_status: previousDraft.draft_status || null,
        source_mode: previousDraft.source_mode || null,
        manual_send_bypass: draftAllowsManualSend(previousDraft),
        final_text: previousDraft.final_text || previousDraft.edited_text || previousDraft.draft_text || null,
        grounding_summary: previousDraft.grounding_summary || {},
        created_at: previousDraft.created_at || null,
      }
      : null,
    draft_request: {
      mode,
      generator_name: GENERATOR_NAME,
      generator_version: GENERATOR_VERSION,
      prompt_version: version,
      target_message_id: targetMessage.id || null,
      output_is_internal_suggestion: true,
      human_review_required: !manualSendBypass,
      manual_send_bypass: manualSendBypass,
      sends_allowed: false,
      ebay_mutations_allowed: false,
    },
  };
}

function buildManualRewriteInput(
  context: Record<string, any>,
  targetMessage: Record<string, any>,
  operatorDraftText: string | null,
  improvementInstructions: string | null,
  previousDraft: Record<string, any> | null,
  version: string,
) {
  const messages = safeArray(context.messages) as Array<Record<string, any>>;
  const buyer = parseObject(context.buyer);
  const history = parseObject(context.buyer_history_summary);
  const conversation = parseObject(context.conversation);
  const latest = latestMessage(messages);
  const latestInbound = latestInboundMessage(messages) || targetMessage || null;
  const nowMs = Date.now();
  const delayHours = (value: unknown) => {
    const timestamp = Date.parse(String(value || ""));
    if (!Number.isFinite(timestamp)) return null;
    const hours = (nowMs - timestamp) / 36e5;
    return Number.isFinite(hours) && hours >= 0 ? Number(hours.toFixed(2)) : null;
  };
  const latestMessageAt = currentMessageTime(latest);
  const latestInboundAt = currentMessageTime(latestInbound);
  const targetMessageAt = currentMessageTime(targetMessage);
  const hoursSinceLatestMessage = delayHours(latestMessageAt);
  const hoursSinceLatestInbound = delayHours(latestInboundAt);
  const delayContext = {
    now: new Date(nowMs).toISOString(),
    latest_message_at: latestMessageAt || null,
    latest_inbound_message_at: latestInboundAt || null,
    target_message_at: targetMessageAt || null,
    hours_since_latest_message: hoursSinceLatestMessage,
    hours_since_latest_inbound_message: hoursSinceLatestInbound,
    significant_delay: typeof hoursSinceLatestInbound === "number" ? hoursSinceLatestInbound >= 24 : false,
    significant_delay_threshold_hours: 24,
  };
  const fullName = text(buyer.name, 180) || null;
  const buyerToneContext = {
    username: buyer.username || null,
    full_name: fullName,
    first_name: fullName ? fullName.split(/\s+/)[0] || null : null,
    confidence: buyer.confidence || null,
    prior_order_count: history.prior_order_count ?? null,
    cash_spent_gross_value: history.gross_value ?? null,
    cash_spent_retained_value: history.retained_value ?? null,
    cash_spent_best_value: history.retained_value ?? history.gross_value ?? null,
    average_order_value: history.average_order_value ?? null,
    return_count: history.return_count ?? null,
    last_prior_purchase_at: history.last_prior_purchase_at || null,
    first_prior_purchase_at: history.first_prior_purchase_at || null,
  };
  return {
    manual_rewrite_only: true,
    operator_draft: safeBodyText(operatorDraftText, MAX_DRAFT_TEXT_CHARS),
    operator_instructions: improvementInstructions || null,
    buyer_tone_context: buyerToneContext,
    response_delay_context: delayContext,
    conversation: {
      id: conversation.id || null,
      ebay_conversation_id: conversation.ebay_conversation_id || null,
      other_party_username: conversation.other_party_username || buyer.username || null,
    },
    target_message: null,
    latest_message: null,
    latest_inbound_message: null,
    timeline: [],
    classification: null,
    objective_context: {
      buyer_tone_context: buyerToneContext,
      response_delay_context: delayContext,
    },
    grounding: {
      facts: [],
      missing_context_options: [],
    },
    previous_draft: previousDraft
      ? {
        id: previousDraft.id || null,
        source_mode: previousDraft.source_mode || null,
        manual_send_bypass: draftAllowsManualSend(previousDraft),
        final_text: previousDraft.final_text || previousDraft.edited_text || previousDraft.draft_text || null,
        created_at: previousDraft.created_at || null,
      }
      : null,
    draft_request: {
      mode: "improve",
      generator_name: GENERATOR_NAME,
      generator_version: GENERATOR_VERSION,
      prompt_version: version,
      target_message_id: targetMessage.id || null,
      output_is_internal_suggestion: true,
      human_review_required: false,
      manual_send_bypass: true,
      manual_rewrite_only: true,
      sends_allowed: false,
      ebay_mutations_allowed: false,
    },
  };
}

function buildManualRewritePrompt(version: string) {
  return `
You are a copy editor for OG eBay Messaging Ops.
Return strict JSON only. Do not include markdown wrappers, prose outside JSON, or chain-of-thought.

Task:
- Rewrite only operator_draft.
- Do not answer the buyer from scratch.
- Do not infer case facts.
- Do not use any conversation, classification, order, return, inventory, replacement, refund-process, or grounding details to change the substance.
- buyer_tone_context is only for name selection, warmth, care level, and VIP-level polish. It may include the buyer's full name and cash-spend/value metrics so you can calibrate the response.
- response_delay_context is only for tone and delay handling. It may include how many hours have passed since the latest buyer message.
- Never mention VIP status, spend amounts, buyer flags, internal segmentation, or internal delay calculations to the buyer.

Hard preservation rules:
- Preserve every operator-written factual claim, named person, offer, concession, refund term, payment form, amount, condition, caveat, and commitment.
- Preserve references to OG if operator_draft mentions OG.
- Preserve offers involving refunds, cash, two-dollar bills, future purchases, replacements, discounts, compensation, timing, and apologies.
- Correct spelling and grammar without changing meaning. For example, "2 dollars bills" may become "two-dollar bills", but must not become a generic "refund process".
- If operator_draft says "I spoke to OG and he wants to give you a refund in two-dollar bills on your next purchase if you are ok with it", the output must preserve that exact substance.
- Do not add "currently there is no replacement available" unless operator_draft says that.
- Do not add "we are reviewing the refund process" unless operator_draft says that.

Style:
- Professional, warm, concise eBay seller reply.
- One short paragraph is preferred.
- Use the buyer's full name or first name when it is naturally available from operator_draft or buyer_tone_context.
- If response_delay_context.significant_delay is true, you may add a brief apology for the delay if it fits naturally and does not change the operator's offer or commitments.
- Keep uncertainty/permission language such as "if you are okay with it".
- No subject line and no signature.

Output JSON fields:
- draft_text: buyer-facing rewritten version only.
- tone: short label such as professional_friendly.
- summary_of_intent: internal one-sentence summary.
- facts_used: empty array unless a fact id is explicitly supplied in grounding.facts.
- missing_context: short internal list if any.
- safety_warnings: short internal list if any.
- confidence: number from 0 to 1.

Prompt version: ${version}.
`.trim();
}

function buildPrompt(version: string) {
  return `
You are an AI draft assistant for OG eBay Messaging Ops.
Return strict JSON only. Do not include markdown wrappers, prose outside JSON, or chain-of-thought.
Your output is an internal editable draft suggestion only. A human operator must review it. Never imply that a message was sent or should be sent automatically.

Draft style:
- Write a concise eBay seller reply for the native eBay message thread.
- Use a professional, friendly, calm tone.
- Prefer one or two short response blocks.
- Do not add a subject line or email signature.
- Do not mention internal systems, databases, Supabase, AI, classification, link confidence, or missing records to the buyer.
- If facts are missing, write a general safe acknowledgement and say we will review/look into the details.
- If objective_context shows a repeat, high-value, or VIP buyer, use that only to make the tone warmer, more careful, and more relationship-aware.
- Do not mention lifetime spend, retained value, VIP status, buyer flags, or internal buyer segmentation to the buyer unless the operator explicitly wrote that language and it is safe.

Manual handwritten improve rules:
- If draft_request.mode is "improve" and draft_request.manual_send_bypass is true, operator_draft is the authoritative source of truth.
- For manual handwritten improve, act as a copy editor only: fix grammar, spelling, punctuation, clarity, tone, flow, and professionalism.
- For manual handwritten improve, do not use target_message, timeline, classification, matched orders, returns, or objective_context to change, add, remove, soften, or correct the substance of operator_draft.
- Preserve all operator-written names, people, offers, concessions, refund terms, payment form, amounts, conditions, caveats, and commitments. For example, if operator_draft says they spoke to OG and OG offered a refund in two-dollar bills on the next purchase, preserve that meaning.
- For manual handwritten improve, objective_context may only influence warmth and care level for repeat, high-value, or VIP buyers.

Grounding rules:
- These grounding rules apply to generate, regenerate, and non-manual improve. They do not override the manual handwritten improve rules above.
- Center the reply on target_message. Treat the full timeline, classification, and objective_context as supporting context.
- Use only the supplied eBay conversation timeline, target buyer message, latest inbound buyer message, classification, and objective_context.
- grounding.facts contains fact ids that may be cited in facts_used. facts_used must contain only those exact ids.
- Buyer-facing factual claims are allowed only when directly supported by objective_context and the relevant grounding fact.
- It is okay to acknowledge what the buyer said as a concern, but do not convert buyer claims into verified facts.
- Do not hallucinate tracking numbers, shipment status, refund status, return approval, replacement availability, exact delivery timing, or inventory availability.
- Do not say an item shipped unless matched order context includes shipped_on_date or an explicitly shipped status.
- Do not say a tracking number exists unless matched order/shipping context includes tracking_number or safe_label_metadata.trackingNumber.
- Do not say a refund was issued, return was accepted, cancellation completed, or package will arrive on a date unless provided context directly supports that exact fact.

Shipping/tracking:
- If the buyer asks where an order is or whether it shipped, inspect matched_orders first.
- If shipped_on_date exists but tracking is missing, you may say the available order information shows shipment on that date and tracking is not currently visible/available here.
- If tracking_number exists, you may include it exactly.
- If no order/shipping context exists, use a general safe reply and do not mention specific shipment status.

Improve mode:
- If draft_request.mode is "improve", the operator_draft is the primary source. Rewrite that exact message for clarity, tone, organization, and professionalism.
- Do not replace the operator_draft with a generic acknowledgement unless the operator_draft itself is unsafe or empty.
- Keep the operator's specific intent, requested action, concessions, caveats, and factual uncertainty.
- Apply operator_instructions when provided, but only for wording, tone, organization, length, or readability.
- Preserve the operator's meaning and caveats.
- For non-manual improve, do not add facts that are not in objective_context or grounding.facts.
- For non-manual improve, do not remove uncertainty where context is missing.
- For non-manual improve, do not add tracking, refunds, order status, delivery dates, replacement availability, promises, or commitments unless directly supported by objective_context and grounding.facts.

Output JSON fields:
- draft_text: buyer-facing draft only.
- tone: short label such as professional_friendly.
- summary_of_intent: internal one-sentence summary.
- facts_used: grounding fact ids used for factual claims.
- missing_context: short internal list of missing context that affected the draft.
- safety_warnings: short internal list of caveats for the operator.
- confidence: number from 0 to 1.

Prompt version: ${version}.
`.trim();
}

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "draft_text",
      "tone",
      "summary_of_intent",
      "facts_used",
      "missing_context",
      "safety_warnings",
      "confidence",
    ],
    properties: {
      draft_text: { type: "string", maxLength: MAX_DRAFT_TEXT_CHARS },
      tone: { type: "string", maxLength: 80 },
      summary_of_intent: { type: "string", maxLength: 300 },
      facts_used: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 20 },
      missing_context: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 20 },
      safety_warnings: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 20 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks = payload?.output
    ?.flatMap((entry: any) => entry?.content || [])
    ?.map((content: any) => content?.text || "")
    ?.filter(Boolean);
  return Array.isArray(chunks) ? chunks.join("\n").trim() : "";
}

async function callOpenAI(input: Record<string, unknown>, prompt: string, model: string) {
  const apiKey = requiredEnv("OPENAI_API_KEY");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        input: [
          { role: "system", content: [{ type: "input_text", text: prompt }] },
          { role: "user", content: [{ type: "input_text", text: stableStringify(input) }] },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ebay_conversation_response_draft",
            strict: true,
            schema: jsonSchema(),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new DraftError("openai_request_failed", {
        phase: "openai",
        transient: TRANSIENT_OPENAI_STATUSES.has(response.status),
        details: { status: response.status },
      });
    }

    const payload = await response.json().catch(() => null);
    const outputText = extractOutputText(payload);
    if (!outputText) throw new DraftError("openai_empty_output", { phase: "openai_parse" });
    return JSON.parse(outputText);
  } catch (error) {
    if (error instanceof DraftError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new DraftError("openai_timeout", { phase: "openai", transient: true });
    }
    if (error instanceof SyntaxError) {
      throw new DraftError("openai_invalid_json", { phase: "openai_parse" });
    }
    throw new DraftError("openai_network_failure", { phase: "openai", transient: true });
  } finally {
    clearTimeout(timeoutId);
  }
}

function containsAny(textValue: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(textValue));
}

function allowedOrderNumbers(input: Record<string, any>) {
  return new Set((safeArray(input.objective_context?.matched_orders) as Array<Record<string, any>>)
    .map((order) => text(order.order_number, 120))
    .filter(Boolean));
}

function validateDraftOutput(raw: unknown, input: Record<string, any>) {
  const errors: string[] = [];
  const safetyWarnings = new Set<string>();
  const isImproveMode = input.draft_request?.mode === "improve";
  const operatorCombined = safeBodyText(input.operator_draft, MAX_DRAFT_TEXT_CHARS).toLowerCase();
  const isManualImprove = isImproveMode && input.draft_request?.manual_send_bypass === true && Boolean(operatorCombined);
  const operatorAlreadySaid = (patterns: RegExp[]) => isImproveMode && Boolean(operatorCombined) && containsAny(operatorCombined, patterns);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      value: buildFallbackDraft(input, "model output was not an object"),
      validationErrors: ["output_not_object"],
      safetyWarnings: ["model output was not an object"],
      fallbackUsed: true,
    };
  }

  const row = raw as Record<string, unknown>;
  const draftText = safeBodyText(row.draft_text, MAX_DRAFT_TEXT_CHARS);
  const tone = text(row.tone, 80) || "professional_friendly";
  const summaryOfIntent = text(row.summary_of_intent, 300) || "Draft a safe operator-reviewed buyer reply.";
  let factsUsed = safeArray(row.facts_used).map((item) => text(item, 240)).filter(Boolean).slice(0, 20);
  const missingContext = safeArray(row.missing_context).map((item) => text(item, 240)).filter(Boolean).slice(0, 20);
  const modelWarnings = safeArray(row.safety_warnings).map((item) => text(item, 240)).filter(Boolean).slice(0, 20);
  const confidence = Math.min(Math.max(Number(row.confidence), 0), 1);

  if (!draftText) errors.push("empty_draft_text");
  if (String(row.draft_text || "").length > MAX_DRAFT_TEXT_CHARS) errors.push("draft_text_too_long");
  if (!Number.isFinite(confidence)) errors.push("invalid_confidence");
  for (const field of ["draft_text", "tone", "summary_of_intent", "facts_used", "missing_context", "safety_warnings", "confidence"]) {
    if (!(field in row)) errors.push(`missing_${field}`);
  }
  if (!Array.isArray(row.facts_used)) errors.push("invalid_facts_used");
  if (!Array.isArray(row.missing_context)) errors.push("invalid_missing_context");
  if (!Array.isArray(row.safety_warnings)) errors.push("invalid_safety_warnings");

  const allowedFactIds = new Set((safeArray(input.grounding?.facts) as GroundingFact[]).map((fact) => fact.id));
  if (isManualImprove) {
    factsUsed = factsUsed.filter((fact) => allowedFactIds.has(fact));
  } else {
    for (const fact of factsUsed) {
      if (!allowedFactIds.has(fact)) errors.push(`unsupported_fact_used:${fact}`);
    }
  }

  const normalized: DraftOutput = {
    draft_text: draftText,
    tone,
    summary_of_intent: summaryOfIntent,
    facts_used: factsUsed,
    missing_context: missingContext,
    safety_warnings: [...new Set([...modelWarnings, ...safetyWarnings])].slice(0, 20),
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };

  if (isManualImprove) {
    if (errors.length) {
      return {
        ok: false,
        value: buildFallbackDraft(input, errors[0] || "manual improve structural validation failed"),
        validationErrors: [...new Set(errors)].slice(0, 40),
        safetyWarnings: normalized.safety_warnings,
        fallbackUsed: true,
        original: normalized,
      };
    }
    return {
      ok: true,
      value: normalized,
      validationErrors: [],
      safetyWarnings: normalized.safety_warnings,
      fallbackUsed: false,
    };
  }

  const combined = draftText.toLowerCase();
  const orderNumbers = allowedOrderNumbers(input);
  const mentionedOrders = draftText.match(/\b\d{2}-\d{5}-\d{5}\b/g) || [];
  for (const orderNumber of mentionedOrders) {
    if (!orderNumbers.has(orderNumber)) errors.push(`unsupported_order_number:${orderNumber}`);
  }

  const orderRows = safeArray(input.objective_context?.matched_orders) as Array<Record<string, any>>;
  const orderTrackingNumber = (order: Record<string, any>) => {
    const metadata = parseObject(order.safe_label_metadata);
    return text(order.tracking_number || metadata.trackingNumber, 200);
  };
  const orderShipmentStatus = (order: Record<string, any>) => {
    const metadata = parseObject(order.safe_label_metadata);
    return text(order.shipment_status || metadata.shipmentStatus || metadata.deliveryStatus, 200);
  };
  const hasTracking = orderRows.some((order) => orderTrackingNumber(order));
  const hasShippedDate = orderRows.some((order) => text(order.shipped_on_date, 120));
  const hasShipmentStatus = orderRows.some((order) => orderShipmentStatus(order));
  const knownTrackingNumbers = new Set(orderRows.map(orderTrackingNumber).filter(Boolean));
  const trackingLike = draftText.match(/\b[A-Z0-9]{10,34}\b/g) || [];
  const trackingClaimPatterns = [/\btracking\s+(number|#)\s+(is|:)/i];
  if (containsAny(combined, trackingClaimPatterns) && !hasTracking && !operatorAlreadySaid(trackingClaimPatterns)) {
    errors.push("unsupported_tracking_number_claim");
    safetyWarnings.add("tracking number claim was not supported by context");
  }
  for (const token of trackingLike) {
    if (/\d/.test(token) && !knownTrackingNumbers.has(token) && !orderNumbers.has(token) && !(isImproveMode && operatorCombined.includes(token.toLowerCase()))) {
      errors.push(`unsupported_tracking_like_token:${token}`);
    }
  }
  const shippingStatusPatterns = [/\b(shipped|has shipped|was shipped|is in transit|out for delivery|delivered|label created)\b/i];
  if (containsAny(combined, shippingStatusPatterns) && !hasShippedDate && !hasShipmentStatus && !operatorAlreadySaid(shippingStatusPatterns)) {
    errors.push("unsupported_shipping_status_claim");
    safetyWarnings.add("shipment status wording was not supported by context");
  }
  const commitmentGroups = [
    {
      code: "unsupported_refund_claim",
      warning: "draft included refund wording needing review",
      patterns: [/\b(refund(ed)?|refund has been|refund is|refund will be|issue a refund|process a refund)\b/i],
    },
    {
      code: "unsupported_return_claim",
      warning: "draft included return approval wording needing review",
      patterns: [/\b(return (has been )?(accepted|approved)|return is approved)\b/i],
    },
    {
      code: "unsupported_replacement_or_credit_claim",
      warning: "draft included replacement, store credit, discount, or compensation wording needing review",
      patterns: [/\b(replacement|store credit|discount|compensation)\s+(is|will be|has been|can be)\b/i],
    },
    {
      code: "unsupported_delivery_timeline_claim",
      warning: "draft included delivery or timing wording needing review",
      patterns: [/\b(arrive tomorrow|arrives tomorrow|will arrive|delivered by|today|tomorrow)\b/i],
    },
  ];
  for (const group of commitmentGroups) {
    if (containsAny(combined, group.patterns) && !operatorAlreadySaid(group.patterns)) {
      errors.push(group.code);
      safetyWarnings.add(group.warning);
    }
  }
  if (containsAny(combined, [/\b(database|supabase|internal system|our system has no|records show no)\b/i])) {
    errors.push("internal_system_language");
    safetyWarnings.add("draft exposed internal system wording");
  }
  if (containsAny(combined, [
    /\b(we|i|our team|og)\s+(are|were|am|was)\s+(at fault|liable|responsible|negligent|wrong)\b/i,
    /\bthis was our mistake\b/i,
  ])) {
    errors.push("unsafe_fault_admission");
    safetyWarnings.add("draft included a fault or liability admission");
  }

  if (errors.length) {
    return {
      ok: false,
      value: buildFallbackDraft(input, errors[0] || "validation failed"),
      validationErrors: [...new Set(errors)].slice(0, 40),
      safetyWarnings: normalized.safety_warnings,
      fallbackUsed: true,
      original: normalized,
    };
  }

  return {
    ok: true,
    value: normalized,
    validationErrors: [],
    safetyWarnings: normalized.safety_warnings,
    fallbackUsed: false,
  };
}

function currentMessageTime(message: Record<string, any> | null) {
  return message?.created_at_ebay || message?.created_at || null;
}

async function loadCurrentLatestMessage(supabase: ServiceClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_messages")
    .select("id, ebay_message_id, direction, created_at_ebay, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at_ebay", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new DraftError("latest_message_lookup_failed", { phase: "draft_staleness" });
  return data as Record<string, any> | null;
}

function staleStatus(row: Record<string, any>, latest: Record<string, any> | null) {
  const checkedAt = new Date().toISOString();
  const latestId = latest?.id || null;
  const latestTime = currentMessageTime(latest);
  const generatedAt = row.created_at || null;
  const latestIsInbound = String(latest?.direction || "").toLowerCase() === "inbound";
  const latestChanged = Boolean(row.latest_message_id && latestId && row.latest_message_id !== latestId);
  const generatedTime = generatedAt ? Date.parse(generatedAt) : NaN;
  const messageTime = latestTime ? Date.parse(latestTime) : NaN;
  const newerMessage = Number.isFinite(generatedTime) && Number.isFinite(messageTime) && messageTime > generatedTime + 1000;
  const isStale = latestChanged || newerMessage;
  return {
    status: isStale ? "stale" : "current",
    is_stale: isStale,
    reason_code: isStale
      ? latestIsInbound ? "newer_inbound_message" : "latest_message_changed"
      : "latest_message_matches_draft",
    message: isStale
      ? latestIsInbound
        ? "This draft was generated before the latest buyer message. Regenerate recommended."
        : "This draft was generated before the latest conversation message. Review or regenerate before using it."
      : "Draft is current for the latest stored conversation message.",
    generated_at: generatedAt,
    checked_at: checkedAt,
    draft_latest_message_id: row.latest_message_id || null,
    current_latest_message_id: latestId,
    current_latest_ebay_message_id: latest?.ebay_message_id || null,
  };
}

function publicDraft(
  row: Record<string, any>,
  staleness: Record<string, unknown> | null = null,
  approvals: Array<Record<string, any>> = [],
  sendAttempts: Array<Record<string, any>> = [],
) {
  const grounding = parseObject(row.grounding_summary);
  const inputSnapshot = parseObject(row.input_snapshot);
  const targetMessage = parseObject(grounding.target_message || inputSnapshot.target_message);
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    target_message_id: row.target_message_id || targetMessage.id || null,
    target_message: Object.keys(targetMessage).length ? targetMessage : null,
    latest_message_id: row.latest_message_id || null,
    classification_id: row.classification_id || null,
    draft_status: row.draft_status || "generated",
    draft_text: row.draft_text || "",
    edited_text: row.edited_text || "",
    final_text: row.final_text || row.edited_text || row.draft_text || "",
    source_mode: row.source_mode || "generate",
    model_name: row.model_name || null,
    prompt_version: row.prompt_version || null,
    input_hash: row.input_hash || null,
    context_hash: row.context_hash || null,
    grounding_summary: row.grounding_summary || {},
    safety_warnings: safeArray(row.safety_warnings),
    validation_status: row.validation_status || "not_validated",
    validation_errors: safeArray(row.validation_errors),
    operator_notes: row.operator_notes || null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    draft_version: Number(row.draft_version || 1),
    is_current: row.is_current === true,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    discarded_at: row.discarded_at || null,
    superseded_at: row.superseded_at || null,
    staleness,
    manual_send_bypass: draftHasManualSendBypass(row),
    approval: publicApprovalState(approvals, staleness, row),
    send_state: publicSendState(sendAttempts),
  };
}

async function loadDraftRows(supabase: ServiceClient, conversationId: string, limit = 20) {
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .select("id, conversation_id, target_message_id, latest_message_id, classification_id, draft_status, draft_text, edited_text, final_text, source_mode, model_name, prompt_version, input_hash, context_hash, grounding_summary, input_snapshot, safety_warnings, validation_status, validation_errors, operator_notes, confidence, draft_version, is_current, created_at, updated_at, discarded_at, superseded_at")
    .eq("conversation_id", conversationId)
    .order("is_current", { ascending: false })
    .order("draft_version", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new DraftError("draft_view_failed", { phase: "draft_view" });
  return (data || []) as Array<Record<string, any>>;
}

async function loadApprovalRows(supabase: ServiceClient, draftIds: string[]) {
  const ids = Array.from(new Set(draftIds.filter(Boolean)));
  if (!ids.length) return [] as Array<Record<string, any>>;
  const { data, error } = await supabase
    .from("ebay_message_approvals")
    .select("id, conversation_id, target_message_id, draft_id, approval_status, approved_by, approved_by_email, approved_at, approval_notes, removed_by, removed_by_email, removed_at, removal_notes, previous_approval_id, idempotency_key, created_at")
    .in("draft_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw new DraftError("approval_lookup_failed", { phase: "approval_lookup", details: { message: error.message } });
  return (data || []) as Array<Record<string, any>>;
}

async function loadSendAttemptRows(supabase: ServiceClient, draftIds: string[]) {
  const ids = Array.from(new Set(draftIds.filter(Boolean)));
  if (!ids.length) return [] as Array<Record<string, any>>;
  const { data, error } = await supabase
    .from("ebay_message_send_attempts")
    .select("id, conversation_id, target_message_id, draft_id, approval_id, attempt_status, provider, provider_message_id, provider_correlation_id, idempotency_key, attempt_sequence, duplicate_of_attempt_id, error_message, provider_response, metadata, sent_at, created_by, created_at, updated_at")
    .in("draft_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw new DraftError("send_attempt_lookup_failed", { phase: "send_attempt_lookup", details: { message: error.message } });
  return (data || []) as Array<Record<string, any>>;
}

function approvalsByDraftId(approvals: Array<Record<string, any>> = []) {
  return approvals.reduce((map, approval) => {
    const draftId = String(approval.draft_id || "");
    if (!draftId) return map;
    if (!map.has(draftId)) map.set(draftId, []);
    map.get(draftId)?.push(approval);
    return map;
  }, new Map<string, Array<Record<string, any>>>());
}

function sendAttemptsByDraftId(attempts: Array<Record<string, any>> = []) {
  return attempts.reduce((map, attempt) => {
    const draftId = String(attempt.draft_id || "");
    if (!draftId) return map;
    if (!map.has(draftId)) map.set(draftId, []);
    map.get(draftId)?.push(attempt);
    return map;
  }, new Map<string, Array<Record<string, any>>>());
}

async function viewDrafts(supabase: ServiceClient, conversationId: string) {
  const [rows, latest] = await Promise.all([
    loadDraftRows(supabase, conversationId, 20),
    loadCurrentLatestMessage(supabase, conversationId),
  ]);
  const draftIds = rows.map((row) => row.id);
  const [approvals, sendAttempts] = await Promise.all([
    loadApprovalRows(supabase, draftIds),
    loadSendAttemptRows(supabase, draftIds),
  ]);
  const approvalMap = approvalsByDraftId(approvals);
  const sendAttemptMap = sendAttemptsByDraftId(sendAttempts);
  const drafts = rows.map((row) =>
    publicDraft(row, staleStatus(row, latest), approvalMap.get(String(row.id)) || [], sendAttemptMap.get(String(row.id)) || [])
  );
  return {
    ok: true,
    mode: "view",
    conversation_id: conversationId,
    drafts,
    current_draft: drafts.find((draft) => draft.is_current && !draft.discarded_at) || drafts.find((draft) => draft.draft_status === "sent") || null,
    draft_count: drafts.length,
    safety: safetyEnvelope(),
  };
}

async function loadCurrentClassification(supabase: ServiceClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_classifications")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new DraftError("classification_lookup_failed", { phase: "draft_input" });
  return data as Record<string, any> | null;
}

async function loadDraftById(supabase: ServiceClient, draftId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle();
  if (error) throw new DraftError("draft_lookup_failed", { phase: "draft_lookup" });
  if (!data?.id) throw new DraftError("draft_not_found", { status: 404, phase: "draft_lookup" });
  return data as Record<string, any>;
}

async function loadCurrentDraft(supabase: ServiceClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("is_current", true)
    .is("discarded_at", null)
    .order("draft_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new DraftError("current_draft_lookup_failed", { phase: "draft_lookup" });
  return data as Record<string, any> | null;
}

async function nextDraftVersion(supabase: ServiceClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .select("draft_version")
    .eq("conversation_id", conversationId)
    .order("draft_version", { ascending: false })
    .limit(1);
  if (error) throw new DraftError("draft_version_lookup_failed", { phase: "draft_write" });
  return Number(data?.[0]?.draft_version || 0) + 1;
}

function groundingSummary(input: Record<string, any>, output: DraftOutput, validation: Record<string, unknown>) {
  const facts = safeArray(input.grounding?.facts) as GroundingFact[];
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  return {
    generator_name: GENERATOR_NAME,
    generator_version: GENERATOR_VERSION,
    prompt_version: input.draft_request?.prompt_version || null,
    facts_available: facts,
    facts_used: output.facts_used.map((id) => factById.get(id) || { id, label: id, value: null }),
    missing_context: output.missing_context,
    safety_warnings: output.safety_warnings,
    validation,
    target_message: input.target_message || null,
    latest_message: input.latest_message,
    latest_inbound_message: input.latest_inbound_message,
    link_confidence: input.objective_context?.link_confidence || {},
    context_warnings: input.objective_context?.context_warnings || [],
  };
}

async function insertDraft(
  supabase: ServiceClient,
  options: {
    conversationId: string;
    targetMessageId: string;
    latestMessageId: string | null;
    classificationId: string | null;
    sourceMode: string;
    model: string;
    promptVersionValue: string;
    promptHash: string;
    inputHash: string;
    contextHash: string;
    inputSnapshot: Record<string, any>;
    output: DraftOutput;
    validationStatus: "valid" | "warning" | "invalid" | "error";
    validationErrors: string[];
    aiOutput: Record<string, unknown>;
    actorId: string | null;
    operatorNotes: string | null;
    draftStatus?: "generated" | "saved";
  },
) {
  const nowIso = new Date().toISOString();
  const version = await nextDraftVersion(supabase, options.conversationId);
  const { error: clearError } = await supabase
    .from("ebay_conversation_response_drafts")
    .update({
      is_current: false,
      superseded_at: nowIso,
      draft_status: "superseded",
    })
    .eq("conversation_id", options.conversationId)
    .eq("is_current", true)
    .neq("draft_status", "sent");
  if (clearError) throw new DraftError("draft_supersede_failed", { phase: "draft_write" });

  const { error: sentClearError } = await supabase
    .from("ebay_conversation_response_drafts")
    .update({
      is_current: false,
      superseded_at: nowIso,
    })
    .eq("conversation_id", options.conversationId)
    .eq("is_current", true)
    .eq("draft_status", "sent");
  if (sentClearError) throw new DraftError("draft_supersede_failed", { phase: "draft_write" });

  const validation = {
    status: options.validationStatus,
    errors: options.validationErrors,
  };
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .insert({
      conversation_id: options.conversationId,
      target_message_id: options.targetMessageId,
      latest_message_id: options.latestMessageId,
      classification_id: options.classificationId,
      draft_status: options.validationStatus === "error" ? "error" : options.draftStatus || "generated",
      draft_text: options.output.draft_text,
      edited_text: null,
      final_text: options.output.draft_text,
      source_mode: options.sourceMode,
      model_name: options.model,
      prompt_version: options.promptVersionValue,
      prompt_hash: options.promptHash,
      input_hash: options.inputHash,
      context_hash: options.contextHash,
      grounding_summary: groundingSummary(options.inputSnapshot, options.output, validation),
      safety_warnings: options.output.safety_warnings,
      validation_status: options.validationStatus,
      validation_errors: options.validationErrors,
      ai_output: options.aiOutput,
      input_snapshot: options.inputSnapshot,
      operator_notes: options.operatorNotes,
      confidence: options.output.confidence,
      draft_version: version,
      is_current: options.validationStatus === "valid" || options.validationStatus === "warning",
      created_by: options.actorId,
      updated_by: options.actorId,
    })
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("draft_insert_failed", { phase: "draft_write", details: { message: error?.message } });
  const latest = await loadCurrentLatestMessage(supabase, options.conversationId);
  return publicDraft(data as Record<string, any>, staleStatus(data as Record<string, any>, latest));
}

async function resolveManualDraftTarget(
  supabase: ServiceClient,
  conversationId: string,
  input: Input,
) {
  const target = input.targetMessageId
    ? await loadTargetMessage(supabase, conversationId, input.targetMessageId)
    : await loadLatestInboundMessage(supabase, conversationId);

  if (!target?.id) {
    throw new DraftError(input.targetMessageId ? "target_message_not_found" : "target_message_required", {
      status: 400,
      phase: "draft_input",
    });
  }
  if (String(target.direction || "").toLowerCase() !== "inbound") {
    throw new DraftError("target_message_must_be_inbound", { status: 400, phase: "draft_input" });
  }
  return target;
}

async function createManualDraft(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null },
) {
  if (!input.draftText) throw new DraftError("draft_text_required", { status: 400, phase: "input" });
  const conversation = await resolveEbayConversation(supabase, {
    conversationId: input.conversationId,
    ebayConversationId: input.ebayConversationId,
    conversationType: input.conversationType,
  });
  const [targetMessage, latestMessage, classification] = await Promise.all([
    resolveManualDraftTarget(supabase, conversation.id, input),
    loadCurrentLatestMessage(supabase, conversation.id),
    loadCurrentClassification(supabase, conversation.id),
  ]);
  const validationErrors = input.draftText.length > EBAY_MAX_MESSAGE_TEXT_CHARS
    ? ["draft_text_too_long_for_ebay"]
    : [];
  const output: DraftOutput = {
    draft_text: input.draftText,
    tone: "operator_written",
    summary_of_intent: "Operator-written buyer reply.",
    facts_used: [],
    missing_context: [],
    safety_warnings: validationErrors.length ? ["Draft exceeds the eBay message character limit."] : [],
    confidence: 1,
  };
  const inputSnapshot = {
    conversation: {
      id: conversation.id,
      ebay_conversation_id: conversation.ebay_conversation_id || null,
      conversation_type: conversation.conversation_type || null,
      other_party_username: conversation.other_party_username || null,
    },
    target_message: compactMessageForDraft(targetMessage),
    latest_message: compactMessageForDraft(latestMessage),
    latest_inbound_message: compactMessageForDraft(targetMessage),
    classification: classification ? effectiveClassification(classification) : null,
    grounding: {
      facts: [],
      missing_context_options: [],
    },
    operator_draft: input.draftText,
    operator_instructions: null,
    previous_draft: null,
    draft_request: {
      mode: "save_edit",
      generator_name: "operator_manual_composer",
      generator_version: "v1",
      prompt_version: MANUAL_PROMPT_VERSION,
      target_message_id: targetMessage.id,
      output_is_internal_suggestion: false,
      human_review_required: false,
      manual_send_bypass: true,
      sends_allowed: false,
      ebay_mutations_allowed: false,
    },
  };
  const promptHash = await sha256Hex(stableStringify({
    prompt: "operator_manual_composer",
    version: MANUAL_PROMPT_VERSION,
  }));
  const inputHash = await sha256Hex(stableStringify({
    generator_name: "operator_manual_composer",
    generator_version: "v1",
    prompt_hash: promptHash,
    input: inputSnapshot,
  }));
  const contextHash = await sha256Hex(stableStringify({
    conversation_id: conversation.id,
    target_message_id: targetMessage.id,
    latest_message_id: latestMessage?.id || null,
    classification_id: classification?.id || null,
  }));

  return await insertDraft(supabase, {
    conversationId: conversation.id,
    targetMessageId: targetMessage.id,
    latestMessageId: latestMessage?.id || null,
    classificationId: classification?.id || null,
    sourceMode: "operator_edit",
    model: "operator_manual",
    promptVersionValue: MANUAL_PROMPT_VERSION,
    promptHash,
    inputHash,
    contextHash,
    inputSnapshot,
    output,
    validationStatus: validationErrors.length ? "warning" : "valid",
    validationErrors,
    aiOutput: {
      manual_composer: true,
      generated_by_ai: false,
    },
    actorId: admin.userId,
    operatorNotes: input.operatorNotes,
    draftStatus: "saved",
  });
}

async function generateDraft(
  supabase: ServiceClient,
  rpcSupabase: ServiceClient,
  input: Input,
  admin: { userId: string | null },
) {
  const conversation = await resolveEbayConversation(supabase, {
    conversationId: input.conversationId,
    ebayConversationId: input.ebayConversationId,
    conversationType: input.conversationType,
  });
  const previousDraft = input.draftId
    ? await loadDraftById(supabase, input.draftId)
    : input.mode === "generate" ? null : await loadCurrentDraft(supabase, conversation.id);
  const operatorDraft = input.mode === "improve"
    ? input.draftText || previousDraft?.final_text || previousDraft?.edited_text || previousDraft?.draft_text || null
    : null;
  if (input.mode === "improve" && !operatorDraft) {
    throw new DraftError("draft_text_required", { status: 400, phase: "input" });
  }

  const model = modelName();
  const [context, classification] = await Promise.all([
    buildEbayConversationContext(supabase, conversation.id, rpcSupabase),
    loadCurrentClassification(supabase, conversation.id),
  ]);
  const targetMessage = await resolveTargetMessage(supabase, conversation.id, context as Record<string, any>, input, previousDraft);
  const manualImprove = input.mode === "improve" && (input.manualComposer || draftAllowsManualSend(previousDraft));
  const promptVersionValue = manualImprove ? `${promptVersion()}-manual-rewrite-v2` : promptVersion();
  const prompt = manualImprove ? buildManualRewritePrompt(promptVersionValue) : buildPrompt(promptVersionValue);
  const promptHash = await sha256Hex(stableStringify({ prompt, schema: jsonSchema(), generator_version: GENERATOR_VERSION }));
  const draftInput = manualImprove
    ? buildManualRewriteInput(
      context as Record<string, any>,
      targetMessage,
      operatorDraft,
      input.improvementInstructions,
      previousDraft,
      promptVersionValue,
    )
    : buildDraftInput(
      context as Record<string, any>,
      classification,
      targetMessage,
      input.mode,
      operatorDraft,
      input.improvementInstructions,
      previousDraft,
      false,
      promptVersionValue,
    );
  const contextHash = await sha256Hex(stableStringify(context));
  const inputHash = await sha256Hex(stableStringify({
    generator_name: GENERATOR_NAME,
    generator_version: GENERATOR_VERSION,
    prompt_hash: promptHash,
    input: draftInput,
  }));

  const rawOutput = await callOpenAI(draftInput, prompt, model);
  const validation = validateDraftOutput(rawOutput, draftInput);
  const output = validation.value;
  const sourceMode = manualImprove
    ? "operator_edit"
    : validation.fallbackUsed ? "system_fallback" : input.mode === "regenerate" ? "regenerate" : input.mode === "improve" ? "improve" : "generate";
  const validationStatus = validation.ok ? "valid" : "warning";
  const latest = draftInput.latest_message as Record<string, any> | null;
  const draft = await insertDraft(supabase, {
    conversationId: conversation.id,
    targetMessageId: targetMessage.id,
    latestMessageId: latest?.id || null,
    classificationId: classification?.id || null,
    sourceMode,
    model,
    promptVersionValue,
    promptHash,
    inputHash,
    contextHash,
    inputSnapshot: draftInput,
    output,
    validationStatus,
    validationErrors: validation.validationErrors,
    aiOutput: {
      raw: parseObject(rawOutput),
      normalized: validation.ok ? output : (validation as any).original || output,
      fallback_used: validation.fallbackUsed,
    },
    actorId: admin.userId,
    operatorNotes: input.operatorNotes,
  });

  return {
    ok: true,
    mode: input.mode,
    conversation_id: conversation.id,
    target_message_id: targetMessage.id,
    draft,
    draft_id: draft.id,
    fallback_used: validation.fallbackUsed,
    validation_status: draft.validation_status,
    validation_errors: draft.validation_errors,
    safety: safetyEnvelope(),
  };
}

function currentDraftText(draft: Record<string, any>) {
  return safeBodyText(draft.final_text || draft.edited_text || draft.draft_text || "", MAX_OPERATOR_TEXT_CHARS);
}

function approvalTargetMessageId(draft: Record<string, any>) {
  return text(draft.target_message_id || previousDraftTargetMessageId(draft), 120) || null;
}

function assertDraftNotSent(draft: Record<string, any>, phase = "draft") {
  if (String(draft.draft_status || "").toLowerCase() === "sent") {
    throw new DraftError("draft_already_sent", { status: 409, phase });
  }
}

async function latestApprovalForDraft(supabase: ServiceClient, draftId: string) {
  const rows = await loadApprovalRows(supabase, [draftId]);
  return latestApprovalEvent(rows);
}

async function insertApprovalRemoval(
  supabase: ServiceClient,
  draft: Record<string, any>,
  admin: { userId: string | null; email: string | null },
  note: string | null,
  previousApproval: Record<string, any> | null = null,
) {
  const latestApproval = previousApproval || await latestApprovalForDraft(supabase, draft.id);
  if (latestApproval?.approval_status !== "approved") return null;

  const targetMessageId = approvalTargetMessageId(draft);
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("ebay_message_approvals")
    .insert({
      conversation_id: draft.conversation_id,
      target_message_id: targetMessageId,
      draft_id: draft.id,
      approval_status: "approval_removed",
      removed_by: admin.userId,
      removed_by_email: admin.email,
      removed_at: nowIso,
      removal_notes: note,
      previous_approval_id: latestApproval.id,
      metadata: {
        reason: "approval_removed",
        previous_approval_id: latestApproval.id,
      },
    })
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("approval_remove_failed", { phase: "approval_write", details: { message: error?.message } });
  return data as Record<string, any>;
}

async function saveDraftTextIfChanged(
  supabase: ServiceClient,
  draft: Record<string, any>,
  draftText: string | null,
  admin: { userId: string | null; email: string | null },
  operatorNotes: string | null,
) {
  const nextText = draftText ? safeBodyText(draftText, MAX_OPERATOR_TEXT_CHARS) : currentDraftText(draft);
  const existingText = currentDraftText(draft);
  if (!nextText || nextText === existingText) return draft;
  assertDraftNotSent(draft, "draft_write");

  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .update({
      draft_status: "saved",
      edited_text: nextText,
      final_text: nextText,
      operator_notes: operatorNotes,
      updated_by: admin.userId,
    })
    .eq("id", draft.id)
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("draft_save_failed", { phase: "draft_write" });

  await insertApprovalRemoval(supabase, data as Record<string, any>, admin, "Draft text changed after approval.");
  return data as Record<string, any>;
}

async function approveDraft(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null; email: string | null },
) {
  let draft = input.draftId
    ? await loadDraftById(supabase, input.draftId)
    : input.conversationId ? await loadCurrentDraft(supabase, input.conversationId) : null;
  if (!input.draftId && (!draft?.id || String(draft.draft_status || "").toLowerCase() === "sent")) {
    draft = await createManualDraft(supabase, input, admin);
  }
  if (!draft?.id) throw new DraftError("draft_not_found", { status: 404, phase: "draft_lookup" });
  assertDraftNotSent(draft, "approval");
  if (draft.discarded_at || draft.is_current !== true) {
    throw new DraftError("draft_not_current", { status: 409, phase: "approval" });
  }

  draft = await saveDraftTextIfChanged(supabase, draft, input.draftText, admin, input.operatorNotes);

  const latest = await loadCurrentLatestMessage(supabase, draft.conversation_id);
  const staleness = staleStatus(draft, latest);
  if (staleness.is_stale === true) {
    throw new DraftError("draft_stale_approval_blocked", { status: 409, phase: "approval", message: String(staleness.message || "Draft is stale.") });
  }

  const targetMessageId = approvalTargetMessageId(draft);
  if (!targetMessageId) throw new DraftError("target_message_required", { status: 400, phase: "approval" });

  const latestApproval = await latestApprovalForDraft(supabase, draft.id);
  if (latestApproval?.approval_status === "approved") {
    const result = await viewDrafts(supabase, draft.conversation_id);
    return { ...result, mode: "approve", draft_id: draft.id, approval_id: latestApproval.id, already_approved: true };
  }

  const approvalId = crypto.randomUUID();
  const idempotencyKey = await sha256Hex(stableStringify({
    scope: "ebay_message_send",
    version: "v1",
    provider: "ebay_commerce_message",
    conversation_id: draft.conversation_id,
    target_message_id: targetMessageId,
    draft_id: draft.id,
    approval_id: approvalId,
  }));
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("ebay_message_approvals")
    .insert({
      id: approvalId,
      conversation_id: draft.conversation_id,
      target_message_id: targetMessageId,
      draft_id: draft.id,
      approval_status: "approved",
      approved_by: admin.userId,
      approved_by_email: admin.email,
      approved_at: nowIso,
      approval_notes: input.approvalNotes,
      idempotency_key: idempotencyKey,
      metadata: {
        provider: "ebay_commerce_message",
        draft_version: draft.draft_version,
        validation_status: draft.validation_status,
        source_mode: draft.source_mode,
      },
    })
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("approval_insert_failed", { phase: "approval_write", details: { message: error?.message } });

  const result = await viewDrafts(supabase, draft.conversation_id);
  return { ...result, mode: "approve", draft_id: draft.id, approval_id: data.id };
}

async function unapproveDraft(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null; email: string | null },
) {
  const draft = input.draftId
    ? await loadDraftById(supabase, input.draftId)
    : input.conversationId ? await loadCurrentDraft(supabase, input.conversationId) : null;

  if (!draft?.id) throw new DraftError("draft_not_found", { status: 404, phase: "draft_lookup" });
  assertDraftNotSent(draft, "approval");

  const latestApproval = await latestApprovalForDraft(supabase, draft.id);
  const removal = await insertApprovalRemoval(
    supabase,
    draft,
    admin,
    input.approvalNotes || input.operatorNotes || "Approval removed by operator.",
    latestApproval,
  );
  const result = await viewDrafts(supabase, draft.conversation_id);
  return {
    ...result,
    mode: "unapprove",
    draft_id: draft.id,
    approval_removed_id: removal?.id || null,
    already_unapproved: !removal,
  };
}

async function saveEdit(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null; email: string | null },
) {
  if (!input.draftText) throw new DraftError("draft_text_required", { status: 400, phase: "input" });
  let draft = input.draftId
    ? await loadDraftById(supabase, input.draftId)
    : input.conversationId ? await loadCurrentDraft(supabase, input.conversationId) : null;
  if (!input.draftId && (!draft?.id || String(draft.draft_status || "").toLowerCase() === "sent")) {
    const created = await createManualDraft(supabase, input, admin);
    return {
      ok: true,
      mode: "save_edit",
      conversation_id: created.conversation_id,
      draft: created,
      draft_id: created.id,
      created_manual_draft: true,
      safety: safetyEnvelope(),
    };
  }
  if (!draft?.id) throw new DraftError("draft_not_found", { status: 404, phase: "draft_lookup" });
  assertDraftNotSent(draft, "draft_write");

  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .update({
      draft_status: "saved",
      edited_text: input.draftText,
      final_text: input.draftText,
      operator_notes: input.operatorNotes,
      updated_by: admin.userId,
    })
    .eq("id", draft.id)
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("draft_save_failed", { phase: "draft_write" });
  await insertApprovalRemoval(supabase, data as Record<string, any>, admin, "Draft edited after approval.");
  const latest = await loadCurrentLatestMessage(supabase, data.conversation_id);
  return {
    ok: true,
    mode: "save_edit",
    conversation_id: data.conversation_id,
    draft: publicDraft(data as Record<string, any>, staleStatus(data as Record<string, any>, latest)),
    safety: safetyEnvelope(),
  };
}

async function discardDraft(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null; email: string | null },
) {
  const draft = input.draftId
    ? await loadDraftById(supabase, input.draftId)
    : input.conversationId ? await loadCurrentDraft(supabase, input.conversationId) : null;

  if (!draft?.id) throw new DraftError("draft_not_found", { status: 404, phase: "draft_lookup" });
  assertDraftNotSent(draft, "draft_write");
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .update({
      draft_status: "discarded",
      is_current: false,
      discarded_at: nowIso,
      updated_by: admin.userId,
    })
    .eq("id", draft.id)
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("draft_discard_failed", { phase: "draft_write" });
  await insertApprovalRemoval(supabase, data as Record<string, any>, admin, "Draft discarded after approval.");
  const latest = await loadCurrentLatestMessage(supabase, data.conversation_id);
  return {
    ok: true,
    mode: "discard",
    conversation_id: data.conversation_id,
    draft: publicDraft(data as Record<string, any>, staleStatus(data as Record<string, any>, latest)),
    safety: safetyEnvelope(),
  };
}

async function loadSendAttemptsForKey(supabase: ServiceClient, idempotencyKey: string) {
  const { data, error } = await supabase
    .from("ebay_message_send_attempts")
    .select("id, conversation_id, target_message_id, draft_id, approval_id, attempt_status, provider, provider_message_id, provider_correlation_id, idempotency_key, attempt_sequence, duplicate_of_attempt_id, error_message, provider_response, metadata, sent_at, created_by, created_at, updated_at")
    .eq("idempotency_key", idempotencyKey)
    .order("attempt_sequence", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new DraftError("send_attempt_lookup_failed", { phase: "send_attempt_lookup", details: { message: error.message } });
  return (data || []) as Array<Record<string, any>>;
}

function nextAttemptSequence(attempts: Array<Record<string, any>>) {
  return attempts.reduce((max, attempt) => Math.max(max, Number(attempt.attempt_sequence || 0)), 0) + 1;
}

function existingDuplicateSource(attempts: Array<Record<string, any>>) {
  const succeeded = attempts.find((attempt) => attempt.attempt_status === "succeeded");
  if (succeeded) {
    return {
      attempt: succeeded,
      reason: "Duplicate send prevented: this draft was already sent.",
    };
  }

  const active = attempts.find((attempt) => ACTIVE_SEND_STATUSES.has(String(attempt.attempt_status || "")));
  if (active) {
    return {
      attempt: active,
      reason: "Duplicate send prevented: a send attempt is already in progress.",
    };
  }

  const unknownFailure = attempts.find((attempt) =>
    attempt.attempt_status === "failed" && parseObject(attempt.metadata).provider_delivery_unknown === true
  );
  if (unknownFailure) {
    return {
      attempt: unknownFailure,
      reason: "Duplicate send prevented: the previous attempt has an unknown eBay delivery state. Verify in eBay before retrying.",
    };
  }

  return null;
}

async function insertSendAttemptWithNextSequence(
  supabase: ServiceClient,
  values: Record<string, unknown>,
) {
  const idempotencyKey = String(values.idempotency_key || "");
  if (!idempotencyKey) throw new DraftError("send_idempotency_key_required", { phase: "send_attempt_write" });

  let lastError: any = null;
  for (let index = 0; index < 4; index += 1) {
    const attempts = await loadSendAttemptsForKey(supabase, idempotencyKey);
    const { data, error } = await supabase
      .from("ebay_message_send_attempts")
      .insert({
        ...values,
        attempt_sequence: nextAttemptSequence(attempts),
      })
      .select("*")
      .single();
    if (!error && data?.id) return data as Record<string, any>;
    lastError = error;
    if (error?.code !== "23505") break;
  }

  throw new DraftError("send_attempt_insert_failed", {
    phase: "send_attempt_write",
    details: { message: lastError?.message || "Unable to create send attempt." },
  });
}

async function insertInitialSendAttempt(
  supabase: ServiceClient,
  values: Record<string, unknown>,
) {
  const idempotencyKey = String(values.idempotency_key || "");
  if (!idempotencyKey) throw new DraftError("send_idempotency_key_required", { phase: "send_attempt_write" });
  const attempts = await loadSendAttemptsForKey(supabase, idempotencyKey);
  const { data, error } = await supabase
    .from("ebay_message_send_attempts")
    .insert({
      ...values,
      attempt_sequence: nextAttemptSequence(attempts),
    })
    .select("*")
    .single();
  if (!error && data?.id) return data as Record<string, any>;
  if (error?.code === "23505") return null;
  throw new DraftError("send_attempt_insert_failed", {
    phase: "send_attempt_write",
    details: { message: error?.message || "Unable to create send attempt." },
  });
}

async function insertDuplicateSendAttempt(
  supabase: ServiceClient,
  draft: Record<string, any>,
  approval: Record<string, any>,
  admin: { userId: string | null; email: string | null },
  duplicateOf: Record<string, any>,
  reason: string,
) {
  return await insertSendAttemptWithNextSequence(supabase, {
    conversation_id: draft.conversation_id,
    target_message_id: approval.target_message_id || approvalTargetMessageId(draft),
    draft_id: draft.id,
    approval_id: approval.id,
    approved_by: approval.approved_by || null,
    approved_at: approval.approved_at || null,
    approval_notes: approval.approval_notes || null,
    attempt_status: "duplicate",
    provider: "ebay_commerce_message",
    idempotency_key: approval.idempotency_key,
    duplicate_of_attempt_id: duplicateOf.id || null,
    error_message: reason,
    provider_response: parseObject(duplicateOf.provider_response),
    metadata: {
      duplicate_prevented: true,
      duplicate_reason: reason,
      duplicate_of_attempt_status: duplicateOf.attempt_status || null,
      duplicate_of_attempt_id: duplicateOf.id || null,
    },
    created_by: admin.userId,
  });
}

async function updateSendAttempt(
  supabase: ServiceClient,
  attemptId: string,
  patch: Record<string, unknown>,
) {
  const { data, error } = await supabase
    .from("ebay_message_send_attempts")
    .update(patch)
    .eq("id", attemptId)
    .select("*")
    .single();
  if (error || !data?.id) {
    throw new DraftError("send_attempt_update_failed", {
      phase: "send_attempt_write",
      details: { message: error?.message || "Unable to update send attempt." },
    });
  }
  return data as Record<string, any>;
}

function providerMessageId(payload: Record<string, unknown>) {
  return text(payload.messageId || payload.message_id || payload.id, 240) || null;
}

function providerCorrelationId(result: Record<string, any>) {
  return text(result.headers?.correlation_id || result.payload?.correlationId || result.payload?.correlation_id, 240) || null;
}

function ebaySendRequestBody(conversation: Record<string, any>, messageText: string) {
  return {
    conversationId: conversation.ebay_conversation_id,
    messageText,
    emailCopyToSender: false,
  };
}

async function manualSendIdempotencyKey(draft: Record<string, any>, targetMessageId: string) {
  return await sha256Hex(stableStringify({
    scope: "ebay_message_send",
    version: "v1",
    provider: "ebay_commerce_message",
    approval_mode: "manual_operator_message",
    conversation_id: draft.conversation_id,
    target_message_id: targetMessageId,
    draft_id: draft.id,
  }));
}

async function markDraftSent(
  supabase: ServiceClient,
  draft: Record<string, any>,
  admin: { userId: string | null },
) {
  const { data, error } = await supabase
    .from("ebay_conversation_response_drafts")
    .update({
      draft_status: "sent",
      updated_by: admin.userId,
    })
    .eq("id", draft.id)
    .select("*")
    .single();
  if (error || !data?.id) throw new DraftError("draft_sent_mark_failed", { phase: "draft_write", details: { message: error?.message } });
  return data as Record<string, any>;
}

async function sendDraft(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null; email: string | null },
) {
  if (input.sendConfirmed !== true) {
    throw new DraftError("send_confirmation_required", { status: 400, phase: "send_confirmation" });
  }

  let draft = input.draftId
    ? await loadDraftById(supabase, input.draftId)
    : input.conversationId ? await loadCurrentDraft(supabase, input.conversationId) : null;

  if (!input.draftId && (!draft?.id || String(draft.draft_status || "").toLowerCase() === "sent") && input.draftText) {
    draft = await createManualDraft(supabase, input, admin);
  }

  if (!draft?.id) throw new DraftError("draft_not_found", { status: 404, phase: "draft_lookup" });
  if (draft.discarded_at || draft.is_current !== true) {
    throw new DraftError("draft_not_current", { status: 409, phase: "send_validation" });
  }
  if (String(draft.draft_status || "").toLowerCase() === "sent") {
    const latestApproval = await latestApprovalForDraft(supabase, draft.id);
    if (latestApproval?.approval_status === "approved" && latestApproval.idempotency_key) {
      const attempts = await loadSendAttemptsForKey(supabase, latestApproval.idempotency_key);
      const duplicate = existingDuplicateSource(attempts);
      if (duplicate) {
        const duplicateAttempt = await insertDuplicateSendAttempt(supabase, draft, latestApproval, admin, duplicate.attempt, duplicate.reason);
        const result = await viewDrafts(supabase, draft.conversation_id);
        return {
          ...result,
          mode: "send",
          duplicate_prevented: true,
          send_attempt: publicSendAttempt(duplicateAttempt),
          duplicate_of_attempt_id: duplicate.attempt.id || null,
          message: duplicate.reason,
          safety: safetyEnvelope({ sendsEnabled: true }),
        };
      }
    }
    if (draftHasManualSendBypass(draft)) {
      const targetMessageId = approvalTargetMessageId(draft);
      if (targetMessageId) {
        const manualApproval = {
          id: null,
          target_message_id: targetMessageId,
          approved_by: null,
          approved_at: null,
          approval_notes: null,
          idempotency_key: await manualSendIdempotencyKey(draft, targetMessageId),
        };
        const attempts = await loadSendAttemptsForKey(supabase, manualApproval.idempotency_key);
        const duplicate = existingDuplicateSource(attempts);
        if (duplicate) {
          const duplicateAttempt = await insertDuplicateSendAttempt(supabase, draft, manualApproval, admin, duplicate.attempt, duplicate.reason);
          const result = await viewDrafts(supabase, draft.conversation_id);
          return {
            ...result,
            mode: "send",
            duplicate_prevented: true,
            send_attempt: publicSendAttempt(duplicateAttempt),
            duplicate_of_attempt_id: duplicate.attempt.id || null,
            message: duplicate.reason,
            safety: safetyEnvelope({ sendsEnabled: true }),
          };
        }
      }
    }
    throw new DraftError("draft_already_sent", { status: 409, phase: "send_validation" });
  }

  if (draftAllowsManualSend(draft)) {
    draft = await saveDraftTextIfChanged(supabase, draft, input.draftText, admin, input.operatorNotes);
  }

  const latest = await loadCurrentLatestMessage(supabase, draft.conversation_id);
  const staleness = staleStatus(draft, latest);
  if (staleness.is_stale === true) {
    throw new DraftError("draft_stale_send_blocked", { status: 409, phase: "send_validation", message: String(staleness.message || "Draft is stale.") });
  }

  const validationStatus = String(draft.validation_status || "");
  if (!["valid", "warning"].includes(validationStatus)) {
    throw new DraftError("draft_validation_send_blocked", { status: 409, phase: "send_validation" });
  }

  const manualSend = draftAllowsManualSend(draft);
  const approval = manualSend ? null : await latestApprovalForDraft(supabase, draft.id);
  if (!manualSend && (approval?.approval_status !== "approved" || !approval.idempotency_key)) {
    throw new DraftError("draft_approval_required", { status: 409, phase: "send_validation" });
  }

  const targetMessageId = approval?.target_message_id || approvalTargetMessageId(draft);
  if (!targetMessageId) throw new DraftError("target_message_required", { status: 400, phase: "send_validation" });
  const targetMessage = await loadTargetMessage(supabase, draft.conversation_id, targetMessageId);
  if (!targetMessage?.id) throw new DraftError("target_message_not_found", { status: 404, phase: "send_validation" });
  if (String(targetMessage.direction || "").toLowerCase() !== "inbound") {
    throw new DraftError("target_message_must_be_inbound", { status: 409, phase: "send_validation" });
  }

  const conversation = await resolveEbayConversation(supabase, { conversationId: draft.conversation_id });
  const ebayConversationId = text(conversation.ebay_conversation_id, 240);
  if (!ebayConversationId) throw new DraftError("ebay_conversation_id_required", { status: 409, phase: "send_validation" });

  const messageText = currentDraftText(draft);
  if (!messageText) throw new DraftError("draft_text_required", { status: 400, phase: "send_validation" });
  if (messageText.length > EBAY_MAX_MESSAGE_TEXT_CHARS) {
    throw new DraftError("draft_text_too_long_for_ebay", {
      status: 400,
      phase: "send_validation",
      message: `eBay Message API allows ${EBAY_MAX_MESSAGE_TEXT_CHARS} characters. Current draft has ${messageText.length}.`,
    });
  }

  const idempotencyKey = manualSend ? await manualSendIdempotencyKey(draft, targetMessageId) : String(approval?.idempotency_key || "");
  const existingAttempts = await loadSendAttemptsForKey(supabase, idempotencyKey);
  const duplicate = existingDuplicateSource(existingAttempts);
  if (duplicate) {
    const duplicateAttempt = await insertDuplicateSendAttempt(supabase, draft, {
      id: approval?.id || null,
      target_message_id: targetMessageId,
      approved_by: approval?.approved_by || null,
      approved_at: approval?.approved_at || null,
      approval_notes: approval?.approval_notes || null,
      idempotency_key: idempotencyKey,
    }, admin, duplicate.attempt, duplicate.reason);
    const result = await viewDrafts(supabase, draft.conversation_id);
    return {
      ...result,
      mode: "send",
      duplicate_prevented: true,
      send_attempt: publicSendAttempt(duplicateAttempt),
      duplicate_of_attempt_id: duplicate.attempt.id || null,
      message: duplicate.reason,
      safety: safetyEnvelope({ sendsEnabled: true }),
    };
  }

  const requestBody = ebaySendRequestBody(conversation, messageText);
  const messageTextSha = await sha256Hex(messageText);
  const initialAttempt = await insertInitialSendAttempt(supabase, {
    conversation_id: draft.conversation_id,
    target_message_id: targetMessage.id,
    draft_id: draft.id,
    approval_id: approval?.id || null,
    approved_by: approval?.approved_by || null,
    approved_at: approval?.approved_at || null,
    approval_notes: approval?.approval_notes || null,
    attempt_status: "sending",
    provider: "ebay_commerce_message",
    idempotency_key: idempotencyKey,
    provider_response: {},
    metadata: {
      provider_path: "/commerce/message/v1/send_message",
      request_body: {
        conversationId: ebayConversationId,
        messageTextSha256: messageTextSha,
        messageTextLength: messageText.length,
        emailCopyToSender: false,
      },
      target_ebay_message_id: targetMessage.ebay_message_id || null,
      operator_confirmed_send: true,
      approval_required: !manualSend,
      manual_send_bypass: manualSend,
      provider_call_started: false,
      provider_delivery_unknown: false,
    },
    created_by: admin.userId,
  });

  if (!initialAttempt) {
    const attemptsAfterRace = await loadSendAttemptsForKey(supabase, idempotencyKey);
    const duplicateAfterRace = existingDuplicateSource(attemptsAfterRace);
    if (duplicateAfterRace) {
      const duplicateAttempt = await insertDuplicateSendAttempt(supabase, draft, {
        id: approval?.id || null,
        target_message_id: targetMessageId,
        approved_by: approval?.approved_by || null,
        approved_at: approval?.approved_at || null,
        approval_notes: approval?.approval_notes || null,
        idempotency_key: idempotencyKey,
      }, admin, duplicateAfterRace.attempt, duplicateAfterRace.reason);
      const result = await viewDrafts(supabase, draft.conversation_id);
      return {
        ...result,
        mode: "send",
        duplicate_prevented: true,
        send_attempt: publicSendAttempt(duplicateAttempt),
        duplicate_of_attempt_id: duplicateAfterRace.attempt.id || null,
        message: duplicateAfterRace.reason,
        safety: safetyEnvelope({ sendsEnabled: true }),
      };
    }
    throw new DraftError("send_attempt_race_detected", { status: 409, phase: "send_attempt_write" });
  }

  let attempt = initialAttempt;

  let token = "";
  try {
    token = await refreshEbayToken();
  } catch (error) {
    const providerResponse = error instanceof DraftError ? parseObject(error.details.provider_response) : {};
    await updateSendAttempt(supabase, attempt.id, {
      attempt_status: "failed",
      error_message: error instanceof Error ? error.message : "eBay OAuth failed.",
      provider_response: providerResponse,
      metadata: {
        ...parseObject(attempt.metadata),
        provider_call_started: false,
        provider_delivery_unknown: false,
        failure_phase: "oauth",
      },
    });
    throw error;
  }

  let providerResult: { ok: boolean; status: number; payload: Record<string, unknown>; headers: Record<string, unknown> };
  try {
    attempt = await updateSendAttempt(supabase, attempt.id, {
      metadata: {
        ...parseObject(attempt.metadata),
        provider_call_started: true,
      },
    });
    providerResult = await ebayPost(token, "/commerce/message/v1/send_message", requestBody);
  } catch (error) {
    const providerResponse = {
      status: null,
      payload: { message: error instanceof Error ? error.message : String(error || "Unknown provider error.") },
      request: parseObject(attempt.metadata).request_body || {},
    };
    await updateSendAttempt(supabase, attempt.id, {
      attempt_status: "failed",
      error_message: "eBay send failed after the provider call started. Verify the conversation in eBay before retrying.",
      provider_response: providerResponse,
      metadata: {
        ...parseObject(attempt.metadata),
        provider_call_started: true,
        provider_delivery_unknown: true,
        failure_phase: "provider_send",
      },
    });
    throw new DraftError("ebay_provider_send_unknown", {
      status: 502,
      phase: "provider_send",
      message: "eBay send failed after the provider call started. Verify the conversation in eBay before retrying.",
      details: { provider_response: providerResponse },
    });
  }

  const providerResponse = {
    status: providerResult.status,
    payload: providerResult.payload,
    headers: providerResult.headers,
    request: parseObject(attempt.metadata).request_body || {},
  };

  if (!providerResult.ok) {
    const errorMessage = `eBay send failed (${providerResult.status}): ${safeMessage(providerResult.payload)}`;
    await updateSendAttempt(supabase, attempt.id, {
      attempt_status: "failed",
      provider_correlation_id: providerCorrelationId(providerResult),
      error_message: errorMessage,
      provider_response: providerResponse,
      metadata: {
        ...parseObject(attempt.metadata),
        provider_call_started: true,
        provider_delivery_unknown: false,
        failure_phase: "provider_send",
      },
    });
    throw new DraftError("ebay_provider_send_failed", {
      status: 502,
      phase: "provider_send",
      message: errorMessage,
      details: { provider_response: providerResponse },
    });
  }

  const nowIso = new Date().toISOString();
  const providerId = providerMessageId(providerResult.payload);
  const providerCorrelation = providerCorrelationId(providerResult);
  attempt = await updateSendAttempt(supabase, attempt.id, {
    attempt_status: "succeeded",
    provider_message_id: providerId,
    provider_correlation_id: providerCorrelation,
    provider_response: providerResponse,
    sent_at: nowIso,
    metadata: {
      ...parseObject(attempt.metadata),
      provider_call_started: true,
      provider_delivery_unknown: false,
      provider_status: "created",
    },
  });
  await markDraftSent(supabase, draft, admin);

  const result = await viewDrafts(supabase, draft.conversation_id);
  return {
    ...result,
    mode: "send",
    draft_id: draft.id,
    approval_id: approval?.id || null,
    send_attempt: publicSendAttempt(attempt),
    provider_message_id: providerId,
    sent_at: nowIso,
    safety: safetyEnvelope({ sendsEnabled: true, messagesSent: 1, ebayMutationsPerformed: true }),
  };
}

function safetyEnvelope(options: { sendsEnabled?: boolean; messagesSent?: number; ebayMutationsPerformed?: boolean } = {}) {
  return {
    sendsEnabled: options.sendsEnabled === true,
    messagesSent: Number(options.messagesSent || 0),
    ebayMutationsPerformed: options.ebayMutationsPerformed === true,
    returnMutationsPerformed: false,
    automaticResponsesSent: 0,
    humanInitiatedOnly: true,
  };
}

function errorPayload(error: unknown) {
  const known = error instanceof DraftError || error instanceof EbayConversationContextError ? error : null;
  return {
    status: known?.status || 500,
    body: {
      ok: false,
      error: known?.code || "unknown_error",
      phase: known?.phase || "unknown",
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      details: error instanceof DraftError ? error.details : {},
      safety: safetyEnvelope(),
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed", safety: safetyEnvelope() });

  const supabase = serviceClient();
  try {
    const admin = await requireAdmin(req, supabase);
    const input = await parseInput(req);
    const rpcSupabase = admin.actorType === "admin" ? authenticatedClient(admin.accessToken) : supabase;

    if (input.mode === "view") {
      const conversation = await resolveEbayConversation(supabase, {
        conversationId: input.conversationId,
        ebayConversationId: input.ebayConversationId,
        conversationType: input.conversationType,
      });
      return json(req, 200, await viewDrafts(supabase, conversation.id));
    }
    if (input.mode === "save_edit") return json(req, 200, await saveEdit(supabase, input, admin));
    if (input.mode === "discard") return json(req, 200, await discardDraft(supabase, input, admin));
    if (input.mode === "approve") return json(req, 200, await approveDraft(supabase, input, admin));
    if (input.mode === "unapprove") return json(req, 200, await unapproveDraft(supabase, input, admin));
    if (input.mode === "send") return json(req, 200, await sendDraft(supabase, input, admin));
    if (["generate", "regenerate", "improve"].includes(input.mode)) {
      return json(req, 200, await generateDraft(supabase, rpcSupabase, input, admin));
    }

    throw new DraftError("invalid_mode", { status: 400, phase: "input" });
  } catch (error) {
    const payload = errorPayload(error);
    return json(req, payload.status, payload.body);
  }
});
