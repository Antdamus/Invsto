import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildEbayConversationContext,
  EbayConversationContextError,
  resolveEbayConversation,
} from "../_shared/ebay-conversation-context.ts";

type ServiceClient = ReturnType<typeof createClient>;
type Mode = "taxonomy_audit" | "classify_conversation" | "classify_recent" | "review_override";

type Input = {
  mode: Mode;
  conversationId: string | null;
  ebayConversationId: string | null;
  conversationType: string | null;
  classificationId: string | null;
  reviewState: string | null;
  overridePayload: Record<string, unknown>;
  operatorNotes: string | null;
  limit: number;
  force: boolean;
};

const CLASSIFIER_NAME = "ebay_conversation_classifier";
const CLASSIFIER_VERSION = "v1";
const PROMPT_VERSION_DEFAULT = "ebay-conversation-classifier-v1";
const OPENAI_TIMEOUT_MS = 45000;
const TRANSIENT_OPENAI_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const TOPIC_TAGS = [
  "return",
  "cancellation",
  "shipping_issue",
  "payment_issue",
  "item_question",
  "missing_item",
  "wrong_item",
  "not_as_described",
  "refund_request",
  "buyer_complaint",
  "custom_order_question",
  "general_question",
  "platform_notice",
  "feedback_issue",
  "offer_question",
  "order_status",
  "delivery_timing",
  "address_change",
] as const;

const PRIORITIES = ["high", "normal", "low"] as const;
const RESPONSE_NEEDS = ["reply_today", "reply_later", "no_reply_needed"] as const;
const BUYER_FLAGS = [
  "vip_buyer",
  "high_value_buyer",
  "repeat_buyer",
  "new_buyer",
  "high_retained_value_buyer",
  "return_prone_buyer",
  "high_return_risk_buyer",
  "low_risk_buyer",
] as const;
const RISK_FLAGS = [
  "refund_risk",
  "chargeback_risk",
  "negative_feedback_risk",
  "return_escalation_risk",
  "cancellation_risk",
  "buyer_unhappy",
  "context_review_needed",
  "low_confidence",
  "unsupported_claim_risk",
] as const;
const REVIEW_STATES = ["pending_review", "approved", "corrected", "dismissed"] as const;

class ClassifierError extends Error {
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
    this.name = "ClassifierError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "classify";
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
  if (!value) throw new ClassifierError("configuration_error", { phase: "configuration" });
  return value;
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
  if (!accessToken) throw new ClassifierError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new ClassifierError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new ClassifierError("configuration_error", { phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new ClassifierError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

function text(value: unknown, maxLength = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeBodyText(value: unknown, maxLength = 5000) {
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

function booleanValue(value: unknown) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampLimit(value: unknown, fallback = 10, max = 25) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), max);
}

function uniqueAllowed(values: unknown, allowed: readonly string[], maxItems = 8) {
  const raw = Array.isArray(values) ? values : [];
  const set = new Set<string>();
  for (const item of raw) {
    const value = text(item, 80);
    if (allowed.includes(value)) set.add(value);
  }
  return [...set].slice(0, maxItems);
}

function parseObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function parseInput(req: Request): Promise<Input> {
  const body = await req.json().catch(() => ({}));
  const rawMode = stringOrNull(body?.mode, 80) || "classify_conversation";
  if (!["taxonomy_audit", "classify_conversation", "classify_recent", "review_override"].includes(rawMode)) {
    throw new ClassifierError("invalid_mode", { status: 400, phase: "input" });
  }
  return {
    mode: rawMode as Mode,
    conversationId: stringOrNull(body?.conversationId || body?.conversation_id, 120),
    ebayConversationId: stringOrNull(body?.ebayConversationId || body?.ebay_conversation_id, 180),
    conversationType: stringOrNull(body?.conversationType || body?.conversation_type, 80),
    classificationId: stringOrNull(body?.classificationId || body?.classification_id, 120),
    reviewState: stringOrNull(body?.reviewState || body?.review_state, 80),
    overridePayload: parseObject(body?.overridePayload || body?.override_payload),
    operatorNotes: stringOrNull(body?.operatorNotes || body?.operator_notes, 1000),
    limit: clampLimit(body?.limit, rawMode === "taxonomy_audit" ? 100 : 10, rawMode === "taxonomy_audit" ? 250 : 25),
    force: booleanValue(body?.force),
  };
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

function promptVersion() {
  return Deno.env.get("EBAY_CONVERSATION_CLASSIFIER_PROMPT_VERSION")?.trim() ||
    Deno.env.get("EMAIL_CLASSIFIER_PROMPT_VERSION")?.trim() ||
    PROMPT_VERSION_DEFAULT;
}

function modelName() {
  return Deno.env.get("OPENAI_EBAY_CONVERSATION_CLASSIFIER_MODEL")?.trim() ||
    Deno.env.get("OPENAI_EMAIL_CLASSIFIER_MODEL")?.trim() ||
    "gpt-4.1-mini";
}

function latestMessage(messages: Array<Record<string, any>>) {
  return messages[messages.length - 1] || null;
}

function latestInboundMessage(messages: Array<Record<string, any>>) {
  return [...messages].reverse().find((message) => String(message.direction || "").toLowerCase() === "inbound") || null;
}

function buyerSignalMetrics(context: Record<string, any>) {
  const history = parseObject(context.buyer_history_summary);
  const priorOrderCount = numberOrNull(history.prior_order_count) || 0;
  const grossValue = numberOrNull(history.gross_value) || 0;
  const retainedValue = numberOrNull(history.retained_value) || 0;
  const averageOrderValue = numberOrNull(history.average_order_value) || 0;
  const returnCount = numberOrNull(history.return_count) || 0;
  const openReturnCount = numberOrNull(history.open_return_count) || 0;
  const cancellationCount = numberOrNull(history.cancellation_count) || 0;
  const returnRate = priorOrderCount > 0 ? returnCount / priorOrderCount : null;
  return {
    prior_order_count: priorOrderCount,
    gross_value: grossValue,
    retained_value: retainedValue,
    average_order_value: averageOrderValue,
    return_count: returnCount,
    open_return_count: openReturnCount,
    cancellation_count: cancellationCount,
    return_rate: returnRate,
  };
}

function deriveBuyerSignals(context: Record<string, any>) {
  const metrics = buyerSignalMetrics(context);
  const hasBuyerHistory = Boolean(context.buyer_history_summary && typeof context.buyer_history_summary === "object");
  const buyerFlags = new Set<string>();
  const riskFlags = new Set<string>();

  if (hasBuyerHistory) {
    if (metrics.prior_order_count <= 1) buyerFlags.add("new_buyer");
    if (metrics.prior_order_count >= 2) buyerFlags.add("repeat_buyer");
    if (metrics.gross_value >= 1000 || metrics.average_order_value >= 500) buyerFlags.add("high_value_buyer");
    if (metrics.retained_value >= 1000) buyerFlags.add("high_retained_value_buyer");
    if (metrics.retained_value >= 2500 || (metrics.prior_order_count >= 5 && metrics.retained_value >= 1000)) buyerFlags.add("vip_buyer");
    if (metrics.return_count >= 2 || (metrics.return_rate !== null && metrics.return_rate >= 0.35)) buyerFlags.add("return_prone_buyer");
    if (metrics.open_return_count > 0 || (metrics.return_rate !== null && metrics.return_rate >= 0.5)) buyerFlags.add("high_return_risk_buyer");
    if (metrics.prior_order_count >= 2 && metrics.return_count === 0 && metrics.cancellation_count === 0) buyerFlags.add("low_risk_buyer");
  }

  const linkConfidence = parseObject(context.link_confidence);
  const warnings = Array.isArray(context.warnings) ? context.warnings : [];
  const confidenceLevel = String(linkConfidence.level || "none");
  if (confidenceLevel === "none" || confidenceLevel === "weak" || warnings.some((item: any) => String(item?.severity || "") === "warning")) {
    riskFlags.add("context_review_needed");
  }

  return {
    buyer_flags: [...buyerFlags].filter((flag) => BUYER_FLAGS.includes(flag as typeof BUYER_FLAGS[number])),
    risk_flags: [...riskFlags].filter((flag) => RISK_FLAGS.includes(flag as typeof RISK_FLAGS[number])),
    metrics: { ...metrics, buyer_history_available: hasBuyerHistory },
  };
}

function buildClassifierInput(context: Record<string, any>, version: string) {
  const messages = Array.isArray(context.messages) ? context.messages as Array<Record<string, any>> : [];
  const latest = latestMessage(messages);
  const inbound = latestInboundMessage(messages);
  const buyerSignals = deriveBuyerSignals(context);
  return {
    conversation: context.conversation || {},
    latest_message: latest ? {
      id: latest.id || null,
      ebay_message_id: latest.ebay_message_id || null,
      direction: latest.direction || null,
      sender_username: latest.sender_username || null,
      recipient_username: latest.recipient_username || null,
      created_at_ebay: latest.created_at_ebay || null,
      subject: latest.subject || null,
      body: safeBodyText(latest.message_body || latest.message_body_preview, 2000),
    } : null,
    latest_inbound_message: inbound ? {
      id: inbound.id || null,
      ebay_message_id: inbound.ebay_message_id || null,
      sender_username: inbound.sender_username || null,
      created_at_ebay: inbound.created_at_ebay || null,
      subject: inbound.subject || null,
      body: safeBodyText(inbound.message_body || inbound.message_body_preview, 2000),
    } : null,
    timeline: messages.slice(-40).map((message) => ({
      id: message.id || null,
      ebay_message_id: message.ebay_message_id || null,
      role: message.direction || "unknown",
      sender_username: message.sender_username || null,
      recipient_username: message.recipient_username || null,
      created_at_ebay: message.created_at_ebay || null,
      subject: message.subject || null,
      body: safeBodyText(message.message_body || message.message_body_preview, 1800),
      has_media: message.has_media === true,
      media_count: Number(message.media_count || 0),
    })),
    linked_context: {
      buyer: context.buyer || {},
      matched_orders: Array.isArray(context.matched_orders) ? context.matched_orders : [],
      matched_order_lines: Array.isArray(context.matched_order_lines) ? context.matched_order_lines : [],
      matched_returns: Array.isArray(context.matched_returns) ? context.matched_returns : [],
      inventory_listing_context: Array.isArray(context.inventory_listing_context) ? context.inventory_listing_context : [],
      link_confidence: context.link_confidence || {},
      warnings: Array.isArray(context.warnings) ? context.warnings : [],
    },
    buyer_financial_context: {
      buyer_history_summary: context.buyer_history_summary || null,
      buyer_value_line_breakdown: Array.isArray(context.buyer_value_line_breakdown) ? context.buyer_value_line_breakdown : [],
      derived_buyer_signals: buyerSignals,
    },
    classifier_context: {
      classifier_name: CLASSIFIER_NAME,
      classifier_version: CLASSIFIER_VERSION,
      prompt_version: version,
      allowed_topic_tags: TOPIC_TAGS,
      allowed_priorities: PRIORITIES,
      allowed_response_needs: RESPONSE_NEEDS,
      allowed_buyer_flags: BUYER_FLAGS,
      allowed_risk_flags: RISK_FLAGS,
    },
    safety: {
      classify_only: true,
      ebay_mutations_allowed: false,
      outlook_classification_allowed: false,
      sends_allowed: false,
    },
  };
}

function buildPrompt(version: string) {
  return `
You are a conversation-level AI classifier for OG eBay Messaging Ops.
Classify only canonical eBay conversation data. Do not classify Outlook emails.
Return strict JSON only. Do not include markdown, prose, or chain-of-thought.

Allowed topic_tags: ${TOPIC_TAGS.join(", ")}.
Allowed priority values: ${PRIORITIES.join(", ")}.
Allowed response_need values: ${RESPONSE_NEEDS.join(", ")}.
Allowed buyer_flags: ${BUYER_FLAGS.join(", ")}.
Allowed risk_flags: ${RISK_FLAGS.join(", ")}.

Use the clean eBay timeline, latest inbound buyer message, linked buyer/order/return/listing context, and buyer financial context.
Keep the taxonomy simple. Multiple topic tags are allowed when genuinely useful.
Use priority "high" only when the operator should see the conversation as important: return/refund dispute, angry buyer, missing/wrong/not-as-described item, chargeback/payment dispute, negative feedback risk, urgent delivery/address issue, or high business exposure.
Use response_need "reply_today" when a buyer-facing reply should happen today. Use "reply_later" for routine non-urgent buyer questions. Use "no_reply_needed" for platform notices, seller/outbound-only threads, or informational conversations.
Use buyer_flags only when supported by supplied financial/history metadata. Favor conservative labels; do not label a buyer risky without return/cancellation/open-return evidence.
Use risk_flags conservatively. "chargeback_risk" requires explicit dispute/chargeback/bank/card threat language. "unsupported_claim_risk" means the claim needs evidence review, not that the buyer is fraudulent.
Do not say a refund is approved, an item shipped, a return accepted, or inventory is available unless supplied context directly supports it.
summary and reasoning_summary must be short operator-facing text. reasoning_summary is a concise reason, not hidden reasoning.

Prompt version: ${version}.
`.trim();
}

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "topic_tags",
      "priority",
      "response_need",
      "buyer_flags",
      "risk_flags",
      "confidence",
      "summary",
      "reasoning_summary",
      "recommended_action",
    ],
    properties: {
      topic_tags: {
        type: "array",
        items: { type: "string", enum: TOPIC_TAGS },
        maxItems: 6,
      },
      priority: { type: "string", enum: PRIORITIES },
      response_need: { type: "string", enum: RESPONSE_NEEDS },
      buyer_flags: {
        type: "array",
        items: { type: "string", enum: BUYER_FLAGS },
        maxItems: BUYER_FLAGS.length,
      },
      risk_flags: {
        type: "array",
        items: { type: "string", enum: RISK_FLAGS },
        maxItems: RISK_FLAGS.length,
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string", maxLength: 280 },
      reasoning_summary: { type: "string", maxLength: 280 },
      recommended_action: { type: "string", maxLength: 180 },
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
          {
            role: "system",
            content: [{ type: "input_text", text: prompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: stableStringify(input) }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ebay_conversation_classification",
            strict: true,
            schema: jsonSchema(),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new ClassifierError("openai_request_failed", {
        phase: "openai",
        transient: TRANSIENT_OPENAI_STATUSES.has(response.status),
        details: { status: response.status },
      });
    }

    const payload = await response.json().catch(() => null);
    const outputText = extractOutputText(payload);
    if (!outputText) throw new ClassifierError("openai_empty_output", { phase: "openai_parse" });
    return JSON.parse(outputText);
  } catch (error) {
    if (error instanceof ClassifierError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ClassifierError("openai_timeout", { phase: "openai", transient: true });
    }
    if (error instanceof SyntaxError) {
      throw new ClassifierError("openai_invalid_json", { phase: "openai_parse" });
    }
    throw new ClassifierError("openai_network_failure", { phase: "openai", transient: true });
  } finally {
    clearTimeout(timeoutId);
  }
}

function keywordRiskFlags(input: Record<string, any>) {
  const haystack = stableStringify(input).toLowerCase();
  const flags = new Set<string>();
  if (/\b(chargeback|charge back|bank dispute|card dispute|payment dispute)\b/.test(haystack)) flags.add("chargeback_risk");
  if (/\b(negative feedback|bad feedback|leave feedback|review)\b/.test(haystack)) flags.add("negative_feedback_risk");
  if (/\b(angry|upset|unacceptable|terrible|scam|fraud|complaint)\b/.test(haystack)) flags.add("buyer_unhappy");
  return [...flags];
}

function normalizeClassificationOutput(raw: unknown, input: Record<string, any>) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ClassifierError("invalid_model_output", { status: 502, phase: "output_validation" });
  }
  const row = raw as Record<string, unknown>;
  const derived = input.buyer_financial_context?.derived_buyer_signals || {};
  const topicTags = uniqueAllowed(row.topic_tags, TOPIC_TAGS, 6);
  const buyerFlags = new Set([
    ...uniqueAllowed(row.buyer_flags, BUYER_FLAGS, BUYER_FLAGS.length),
    ...uniqueAllowed(derived.buyer_flags || [], BUYER_FLAGS, BUYER_FLAGS.length),
  ]);
  const riskFlags = new Set([
    ...uniqueAllowed(row.risk_flags, RISK_FLAGS, RISK_FLAGS.length),
    ...uniqueAllowed(derived.risk_flags || [], RISK_FLAGS, RISK_FLAGS.length),
    ...keywordRiskFlags(input),
  ]);
  const topics = topicTags.length ? topicTags : [String(input.conversation?.conversation_type || "") === "FROM_EBAY" ? "platform_notice" : "general_question"];

  if (topics.some((tag) => ["return", "refund_request", "not_as_described", "missing_item", "wrong_item"].includes(tag))) riskFlags.add("refund_risk");
  if (topics.includes("cancellation")) riskFlags.add("cancellation_risk");
  if (topics.includes("buyer_complaint")) riskFlags.add("buyer_unhappy");

  const confidence = Math.min(Math.max(Number(row.confidence), 0), 1);
  if (!Number.isFinite(confidence)) throw new ClassifierError("invalid_model_confidence", { status: 502, phase: "output_validation" });
  if (confidence < 0.7) riskFlags.add("low_confidence");

  let priority = String(row.priority || "normal");
  let responseNeed = String(row.response_need || "reply_later");
  if (!PRIORITIES.includes(priority as typeof PRIORITIES[number])) priority = "normal";
  if (!RESPONSE_NEEDS.includes(responseNeed as typeof RESPONSE_NEEDS[number])) responseNeed = "reply_later";
  if (riskFlags.has("chargeback_risk")) {
    priority = "high";
    responseNeed = "reply_today";
  }
  if (priority === "low" && riskFlags.has("refund_risk")) priority = "normal";
  if (responseNeed === "no_reply_needed" && topics.some((tag) => ["return", "refund_request", "buyer_complaint", "payment_issue"].includes(tag))) {
    responseNeed = "reply_today";
  }

  return {
    topic_tags: topics,
    priority,
    response_need: responseNeed,
    buyer_flags: [...buyerFlags].filter((flag) => BUYER_FLAGS.includes(flag as typeof BUYER_FLAGS[number])),
    risk_flags: [...riskFlags].filter((flag) => RISK_FLAGS.includes(flag as typeof RISK_FLAGS[number])),
    confidence,
    summary: text(row.summary, 280) || "Conversation needs operator review.",
    reasoning_summary: text(row.reasoning_summary, 280) || "Classified from the eBay conversation and linked context.",
    recommended_action: text(row.recommended_action, 180) || (
      responseNeed === "reply_today" ? "Review and answer today." : responseNeed === "reply_later" ? "Review when queue allows." : "No reply needed unless new buyer activity appears."
    ),
  };
}

function effectiveState(row: Record<string, any>) {
  const override = parseObject(row.operator_override_payload);
  return {
    priority: String(override.priority || row.priority || "normal"),
    response_need: String(override.response_need || row.response_need || "reply_later"),
    topic_tags: uniqueAllowed(override.topic_tags || row.topic_tags || [], TOPIC_TAGS, 8),
    buyer_flags: uniqueAllowed(override.buyer_flags || row.buyer_flags || [], BUYER_FLAGS, BUYER_FLAGS.length),
    risk_flags: uniqueAllowed(override.risk_flags || row.risk_flags || [], RISK_FLAGS, RISK_FLAGS.length),
    summary: text(override.summary || row.summary, 280),
    reasoning_summary: text(override.reasoning_summary || row.reasoning_summary, 280),
    recommended_action: text(override.recommended_action || row.recommended_action, 180),
  };
}

function publicClassification(row: Record<string, any> | null) {
  if (!row) return null;
  const effective = effectiveState(row);
  const override = parseObject(row.operator_override_payload);
  return {
    ...row,
    effective_priority: effective.priority,
    effective_response_need: effective.response_need,
    effective_topic_tags: effective.topic_tags,
    effective_buyer_flags: effective.buyer_flags,
    effective_risk_flags: effective.risk_flags,
    effective_summary: effective.summary,
    effective_reasoning_summary: effective.reasoning_summary,
    effective_recommended_action: effective.recommended_action,
    has_operator_override: Object.keys(override).length > 0,
  };
}

async function currentClassification(supabase: ServiceClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_classifications")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ClassifierError("classification_lookup_failed", { phase: "classification_lookup" });
  return data as Record<string, any> | null;
}

async function reuseExistingClassification(supabase: ServiceClient, conversationId: string, inputHash: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_classifications")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("source", "ai")
    .eq("classifier_name", CLASSIFIER_NAME)
    .eq("classifier_version", CLASSIFIER_VERSION)
    .eq("input_hash", inputHash)
    .eq("classification_status", "classified")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ClassifierError("classification_lookup_failed", { phase: "classification_lookup" });
  return data as Record<string, any> | null;
}

async function markCurrent(supabase: ServiceClient, conversationId: string, classificationId: string) {
  const nowIso = new Date().toISOString();
  const { error: clearError } = await supabase
    .from("ebay_conversation_classifications")
    .update({ is_current: false, superseded_at: nowIso })
    .eq("conversation_id", conversationId)
    .eq("is_current", true)
    .neq("id", classificationId);
  if (clearError) throw new ClassifierError("classification_supersede_failed", { phase: "classification_persist" });

  const { data, error } = await supabase
    .from("ebay_conversation_classifications")
    .update({ is_current: true, superseded_at: null })
    .eq("id", classificationId)
    .select("*")
    .single();
  if (error || !data?.id) throw new ClassifierError("classification_current_update_failed", { phase: "classification_persist" });
  return data as Record<string, any>;
}

async function persistClassification(
  supabase: ServiceClient,
  options: {
    conversationId: string;
    input: Record<string, any>;
    context: Record<string, any>;
    normalized: Record<string, unknown>;
    original: unknown;
    inputHash: string;
    contextHash: string;
    model: string;
    prompt: string;
    adminUserId: string | null;
  },
) {
  const latest = options.input.latest_message || {};
  const nowIso = new Date().toISOString();
  const { error: clearError } = await supabase
    .from("ebay_conversation_classifications")
    .update({ is_current: false, superseded_at: nowIso })
    .eq("conversation_id", options.conversationId)
    .eq("is_current", true);
  if (clearError) throw new ClassifierError("classification_supersede_failed", { phase: "classification_persist" });

  const { data, error } = await supabase
    .from("ebay_conversation_classifications")
    .insert({
      conversation_id: options.conversationId,
      latest_message_id: latest.id || null,
      latest_ebay_message_id: latest.ebay_message_id || null,
      source: "ai",
      classification_status: "classified",
      priority: options.normalized.priority,
      response_need: options.normalized.response_need,
      topic_tags: options.normalized.topic_tags,
      buyer_flags: options.normalized.buyer_flags,
      risk_flags: options.normalized.risk_flags,
      confidence: options.normalized.confidence,
      summary: options.normalized.summary,
      reasoning_summary: options.normalized.reasoning_summary,
      recommended_action: options.normalized.recommended_action,
      input_hash: options.inputHash,
      context_hash: options.contextHash,
      classifier_name: CLASSIFIER_NAME,
      classifier_version: CLASSIFIER_VERSION,
      prompt_version: options.prompt,
      model_name: options.model,
      original_ai_output: parseObject(options.original),
      normalized_ai_output: options.normalized,
      input_snapshot: options.input,
      validation_metadata: {
        derived_buyer_signals: options.input.buyer_financial_context?.derived_buyer_signals || null,
        context_version: options.context.context_version || null,
      },
      is_current: true,
      review_state: "pending_review",
      created_by: options.adminUserId,
    })
    .select("*")
    .single();
  if (error || !data?.id) {
    throw new ClassifierError("classification_insert_failed", { phase: "classification_persist", details: { message: error?.message } });
  }
  return data as Record<string, any>;
}

async function classifyConversation(
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
  const version = promptVersion();
  const model = modelName();
  const context = await buildEbayConversationContext(supabase, conversation.id, rpcSupabase);
  const classifierInput = buildClassifierInput(context as Record<string, any>, version);
  const inputHash = await sha256Hex(stableStringify(classifierInput));
  const contextHash = await sha256Hex(stableStringify(context));

  if (!input.force) {
    const current = await currentClassification(supabase, conversation.id);
    if (current?.input_hash === inputHash) {
      return {
        ok: true,
        mode: "classify_conversation",
        reused: true,
        conversation_id: conversation.id,
        classification: publicClassification(current),
        safety: safetyEnvelope(),
      };
    }
    const reusable = await reuseExistingClassification(supabase, conversation.id, inputHash);
    if (reusable?.id) {
      const marked = await markCurrent(supabase, conversation.id, reusable.id);
      return {
        ok: true,
        mode: "classify_conversation",
        reused: true,
        conversation_id: conversation.id,
        classification: publicClassification(marked),
        safety: safetyEnvelope(),
      };
    }
  }

  const rawOutput = await callOpenAI(classifierInput, buildPrompt(version), model);
  const normalized = normalizeClassificationOutput(rawOutput, classifierInput);
  const saved = await persistClassification(supabase, {
    conversationId: conversation.id,
    input: classifierInput,
    context: context as Record<string, any>,
    normalized,
    original: rawOutput,
    inputHash,
    contextHash,
    model,
    prompt: version,
    adminUserId: admin.userId,
  });

  return {
    ok: true,
    mode: "classify_conversation",
    reused: false,
    conversation_id: conversation.id,
    ebay_conversation_id: conversation.ebay_conversation_id,
    classification: publicClassification(saved),
    safety: safetyEnvelope(),
  };
}

function sanitizeOverridePayload(value: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};
  const priority = text(value.priority, 40);
  const responseNeed = text(value.response_need || value.responseNeed, 60);
  const summary = text(value.summary, 280);
  const reasoningSummary = text(value.reasoning_summary || value.reasoningSummary, 280);
  const recommendedAction = text(value.recommended_action || value.recommendedAction, 180);

  if (PRIORITIES.includes(priority as typeof PRIORITIES[number])) payload.priority = priority;
  if (RESPONSE_NEEDS.includes(responseNeed as typeof RESPONSE_NEEDS[number])) payload.response_need = responseNeed;
  if ("topic_tags" in value || "topicTags" in value) payload.topic_tags = uniqueAllowed(value.topic_tags || value.topicTags, TOPIC_TAGS, 8);
  if ("buyer_flags" in value || "buyerFlags" in value) payload.buyer_flags = uniqueAllowed(value.buyer_flags || value.buyerFlags, BUYER_FLAGS, BUYER_FLAGS.length);
  if ("risk_flags" in value || "riskFlags" in value) payload.risk_flags = uniqueAllowed(value.risk_flags || value.riskFlags, RISK_FLAGS, RISK_FLAGS.length);
  if (summary) payload.summary = summary;
  if (reasoningSummary) payload.reasoning_summary = reasoningSummary;
  if (recommendedAction) payload.recommended_action = recommendedAction;

  return Object.fromEntries(Object.entries(payload).filter(([, item]) => {
    if (Array.isArray(item)) return true;
    return item !== null && item !== undefined && item !== "";
  }));
}

async function reviewOverride(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string | null; email: string | null },
) {
  const reviewState = input.reviewState || "corrected";
  if (!REVIEW_STATES.includes(reviewState as typeof REVIEW_STATES[number])) {
    throw new ClassifierError("invalid_review_state", { status: 400, phase: "review_input" });
  }

  let query = supabase
    .from("ebay_conversation_classifications")
    .select("*")
    .eq("is_current", true)
    .limit(1);
  if (input.classificationId) query = query.eq("id", input.classificationId);
  else if (input.conversationId) query = query.eq("conversation_id", input.conversationId);
  else throw new ClassifierError("classification_id_required", { status: 400, phase: "review_input" });

  const { data: existing, error: lookupError } = await query.maybeSingle();
  if (lookupError) throw new ClassifierError("classification_lookup_failed", { phase: "review_lookup" });
  if (!existing?.id) throw new ClassifierError("classification_not_found", { status: 404, phase: "review_lookup" });

  const previousState = effectiveState(existing as Record<string, any>);
  const overridePayload = sanitizeOverridePayload(input.overridePayload);
  const nextOverride = Object.keys(overridePayload).length
    ? overridePayload
    : parseObject((existing as Record<string, any>).operator_override_payload);
  const newState = effectiveState({ ...(existing as Record<string, any>), operator_override_payload: nextOverride });
  const eventType = reviewState === "approved" || reviewState === "corrected" || reviewState === "dismissed"
    ? reviewState
    : "review_saved";
  const nowIso = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from("ebay_conversation_classifications")
    .update({
      review_state: reviewState,
      operator_override_payload: nextOverride,
      operator_notes: input.operatorNotes,
      reviewed_by: admin.userId,
      reviewed_at: nowIso,
    })
    .eq("id", existing.id)
    .select("*")
    .single();
  if (updateError || !updated?.id) throw new ClassifierError("classification_review_update_failed", { phase: "review_update" });

  const { error: auditError } = await supabase
    .from("ebay_conversation_classification_overrides")
    .insert({
      classification_id: existing.id,
      conversation_id: existing.conversation_id,
      event_type: eventType,
      previous_state: previousState,
      override_payload: nextOverride,
      new_state: newState,
      operator_notes: input.operatorNotes,
      created_by: admin.userId,
      created_by_email: admin.email,
    });
  if (auditError) throw new ClassifierError("classification_review_audit_failed", { phase: "review_audit" });

  return {
    ok: true,
    mode: "review_override",
    conversation_id: updated.conversation_id,
    classification: publicClassification(updated as Record<string, any>),
    safety: safetyEnvelope(),
  };
}

function topicHits(textValue: string) {
  const body = textValue.toLowerCase();
  const hits = new Set<string>();
  const rules: Array<[string, RegExp]> = [
    ["return", /\b(return|returned|returning|rma)\b/],
    ["cancellation", /\b(cancel|cancellation|cancelled|canceled)\b/],
    ["shipping_issue", /\b(ship|shipping|tracking|delivery|delivered|late|lost|address)\b/],
    ["payment_issue", /\b(payment|paid|invoice|charge|card|bank)\b/],
    ["item_question", /\b(question|available|size|condition|authentic|measure|photo|picture)\b/],
    ["missing_item", /\b(missing|not received|never received|empty box)\b/],
    ["wrong_item", /\b(wrong item|different item|not what i ordered)\b/],
    ["not_as_described", /\b(not as described|damaged|broken|fake|defect|defective)\b/],
    ["refund_request", /\b(refund|money back|partial)\b/],
    ["buyer_complaint", /\b(upset|angry|complaint|unacceptable|terrible)\b/],
    ["feedback_issue", /\b(feedback|review|rating)\b/],
    ["offer_question", /\b(offer|counteroffer|price|discount)\b/],
  ];
  for (const [tag, regex] of rules) {
    if (regex.test(body)) hits.add(tag);
  }
  if (!hits.size) hits.add("general_question");
  return [...hits].filter((tag) => TOPIC_TAGS.includes(tag as typeof TOPIC_TAGS[number]));
}

async function taxonomyAudit(supabase: ServiceClient, input: Input) {
  const { data: conversations, error } = await supabase
    .from("ebay_conversations")
    .select("id, ebay_conversation_id, conversation_type, conversation_title, other_party_username, reference_id, reference_type, latest_message_preview, unread_count, last_message_created_at, message_count")
    .order("last_message_created_at", { ascending: false, nullsFirst: false })
    .limit(input.limit);
  if (error) throw new ClassifierError("taxonomy_conversation_lookup_failed", { phase: "taxonomy_audit" });

  const ids = (conversations || []).map((row: Record<string, any>) => row.id).filter(Boolean);
  const [messagesResult, linksResult] = ids.length ? await Promise.all([
    supabase
      .from("ebay_conversation_messages")
      .select("conversation_id, direction, sender_username, subject, message_body_preview, message_body, created_at_ebay")
      .in("conversation_id", ids)
      .order("created_at_ebay", { ascending: false, nullsFirst: false })
      .limit(Math.min(ids.length * 20, 2000)),
    supabase
      .from("ebay_conversation_links")
      .select("conversation_id, link_type, status")
      .in("conversation_id", ids)
      .in("status", ["confirmed", "suggested"])
      .limit(2000),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (messagesResult.error) throw new ClassifierError("taxonomy_message_lookup_failed", { phase: "taxonomy_audit" });
  if (linksResult.error) throw new ClassifierError("taxonomy_link_lookup_failed", { phase: "taxonomy_audit" });

  const messagesByConversation = new Map<string, Array<Record<string, any>>>();
  for (const message of messagesResult.data || []) {
    const key = String(message.conversation_id || "");
    messagesByConversation.set(key, [...(messagesByConversation.get(key) || []), message]);
  }
  const linkSummary = new Map<string, { order: boolean; return: boolean; suggested: boolean }>();
  for (const link of linksResult.data || []) {
    const key = String(link.conversation_id || "");
    const current = linkSummary.get(key) || { order: false, return: false, suggested: false };
    current.order ||= ["ebay_order", "ebay_order_line"].includes(String(link.link_type || ""));
    current.return ||= String(link.link_type || "") === "ebay_return_case";
    current.suggested ||= String(link.status || "") === "suggested";
    linkSummary.set(key, current);
  }

  const topicCounts: Record<string, number> = {};
  const samples: Array<Record<string, unknown>> = [];
  let unread = 0;
  let withOrders = 0;
  let withReturns = 0;
  let suggestedLinks = 0;
  for (const conversation of conversations || []) {
    const messages = messagesByConversation.get(String(conversation.id)) || [];
    const blob = [
      conversation.conversation_title,
      conversation.latest_message_preview,
      ...messages.flatMap((message) => [message.subject, message.message_body_preview, message.message_body]),
    ].filter(Boolean).join("\n");
    const hits = topicHits(blob);
    for (const hit of hits) topicCounts[hit] = (topicCounts[hit] || 0) + 1;
    const links = linkSummary.get(String(conversation.id)) || { order: false, return: false, suggested: false };
    if (Number(conversation.unread_count || 0) > 0) unread += 1;
    if (links.order) withOrders += 1;
    if (links.return) withReturns += 1;
    if (links.suggested) suggestedLinks += 1;
    if (samples.length < 12) {
      samples.push({
        conversation_id: conversation.id,
        ebay_conversation_id: conversation.ebay_conversation_id,
        buyer: conversation.other_party_username || null,
        conversation_type: conversation.conversation_type,
        topic_hits: hits,
        has_order_link: links.order,
        has_return_link: links.return,
        suggested_link: links.suggested,
        latest_preview: text(conversation.latest_message_preview, 180),
      });
    }
  }

  return {
    ok: true,
    mode: "taxonomy_audit",
    audited_conversations: (conversations || []).length,
    counters: {
      unread,
      with_orders: withOrders,
      with_returns: withReturns,
      suggested_links: suggestedLinks,
      topic_counts: topicCounts,
    },
    proposed_beta_taxonomy: {
      topic_tags: TOPIC_TAGS,
      priority: PRIORITIES,
      response_need: RESPONSE_NEEDS,
      buyer_flags: BUYER_FLAGS,
      risk_flags: RISK_FLAGS,
      visible_in_list: ["priority", "response_need", "top_topic", "strongest_buyer_flag"],
      stored_for_detail: ["all_topic_tags", "all_buyer_flags", "risk_flags", "summary", "reasoning_summary", "recommended_action", "override_history"],
    },
    samples,
    safety: safetyEnvelope(),
  };
}

async function classifyRecent(
  supabase: ServiceClient,
  rpcSupabase: ServiceClient,
  input: Input,
  admin: { userId: string | null },
) {
  const { data, error } = await supabase
    .from("ebay_conversations")
    .select("id")
    .order("last_message_created_at", { ascending: false, nullsFirst: false })
    .limit(input.limit);
  if (error) throw new ClassifierError("recent_conversation_lookup_failed", { phase: "classify_recent" });

  const results = [];
  for (const conversation of data || []) {
    try {
      const result = await classifyConversation(supabase, rpcSupabase, {
        ...input,
        mode: "classify_conversation",
        conversationId: conversation.id,
        ebayConversationId: null,
      }, admin);
      results.push({
        conversation_id: conversation.id,
        ok: true,
        reused: result.reused,
        classification: result.classification,
      });
    } catch (error) {
      results.push({
        conversation_id: conversation.id,
        ok: false,
        error: error instanceof ClassifierError ? error.code : "unknown_error",
        phase: error instanceof ClassifierError ? error.phase : "unknown",
      });
    }
  }

  return {
    ok: true,
    mode: "classify_recent",
    requested: input.limit,
    processed: results.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
    safety: safetyEnvelope(),
  };
}

function safetyEnvelope() {
  return {
    ebayMutationsPerformed: false,
    outlookMutationsPerformed: false,
    sendsEnabled: false,
    messagesSent: 0,
    classificationOnly: true,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  const supabase = serviceClient();
  try {
    const accessToken = getBearerToken(req);
    const admin = await requireAdmin(req, supabase);
    const input = await parseInput(req);
    const rpcSupabase = admin.actorType === "admin" ? authenticatedClient(accessToken) : supabase;

    if (input.mode === "taxonomy_audit") return json(req, 200, await taxonomyAudit(supabase, input));
    if (input.mode === "review_override") return json(req, 200, await reviewOverride(supabase, input, admin));
    if (input.mode === "classify_recent") return json(req, 200, await classifyRecent(supabase, rpcSupabase, input, admin));
    return json(req, 200, await classifyConversation(supabase, rpcSupabase, input, admin));
  } catch (error) {
    const known = error instanceof ClassifierError || error instanceof EbayConversationContextError ? error : null;
    return json(req, known?.status || 500, {
      ok: false,
      error: known?.code || "unknown_error",
      phase: known?.phase || "unknown",
      transient: known instanceof ClassifierError ? known.transient : false,
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      safety: safetyEnvelope(),
    });
  }
});
