import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLASSIFIER_NAME = "og-email-triage-classifier";
const CLASSIFIER_VERSION = "4b.4-v1";
const TAXONOMY_VERSION = "step-4b.4-v1";
const RESPONSE_DRAFT_GENERATOR_NAME = "og-email-triage-response-drafter";
const RESPONSE_DRAFT_GENERATOR_VERSION = "4d.6-v1";
const RESPONSE_DRAFT_PROMPT_VERSION_DEFAULT = "step-4d.6-v1";
const TRUNCATION_VERSION = "head-12000-tail-2000-v1";
const LINK_CONTEXT_VERSION = "links-compact-v1";
const VERIFIED_ORDER_CONTEXT_VERSION = "verified-ebay-order-context-v1";
const HEAD_CHARS = 12000;
const TAIL_CHARS = 2000;
const MAX_LIMIT = 50;
const OPENAI_TIMEOUT_MS = 30000;
const MESSAGE_DETAIL_BODY_CHAR_LIMIT = 14000;
const MAX_DRAFT_BODY_CHARS = 5000;
const MAX_DRAFT_SUBJECT_CHARS = 180;

const SUPPORTED_MODES = ["enqueue_only", "process_queued", "enqueue_and_process", "process_message", "dry_run", "replay_classification", "admin_view", "message_detail", "admin_context_view", "operator_match_context", "confirm_match", "reject_match", "mark_match_stale", "save_review", "generate_response", "regenerate_response", "admin_draft_view", "save_draft_review", "approve_draft", "reject_draft"] as const;
const CATEGORIES = [
  "buyer_message",
  "order_paid",
  "shipping_label",
  "shipping_issue",
  "return_request",
  "refund_request",
  "cancellation_request",
  "item_not_received",
  "item_not_as_described",
  "payment_issue",
  "offer_or_negotiation",
  "inventory_question",
  "authenticity_or_condition_question",
  "platform_notice",
  "account_security",
  "marketing_or_promotion",
  "spam_or_noise",
  "internal_or_other",
] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
const URGENCIES = ["none", "later", "soon", "today", "immediate"] as const;
const REVIEW_STATES = ["pending_review", "approved", "corrected", "dismissed"] as const;
const PRIORITY_LEVELS = ["low", "medium", "high", "critical"] as const;
const URGENCY_LEVELS = ["low", "today", "immediate"] as const;
const RESPONSE_TIMINGS = ["no_response_needed", "within_72_hours", "within_24_hours", "immediate_attention"] as const;
const CUSTOMER_RISKS = ["low", "medium", "high", "critical"] as const;
const RECOMMENDED_ACTIONS = [
  "no_action",
  "archive_or_ignore",
  "review_only",
  "review_and_reply",
  "check_order_status",
  "check_shipping_status",
  "upload_or_verify_tracking",
  "prepare_return_response",
  "prepare_refund_review",
  "prepare_cancellation_review",
  "inspect_listing_or_inventory",
  "escalate_to_admin",
  "security_review",
] as const;
const SAFETY_FLAGS = [
  "possible_pii",
  "payment_or_refund",
  "account_security",
  "low_confidence",
  "ambiguous_order_match",
  "body_truncated",
  "possible_spam",
  "hallucinated_entity_removed",
] as const;
const RESPONSE_DRAFT_SAFETY_FLAGS = [
  "requires_human_review",
  "sensitive_category",
  "payment_or_refund",
  "account_security",
  "chargeback_risk",
  "legal_or_policy_risk",
  "unsupported_claim",
  "unsafe_refund_promise",
  "unsafe_compensation_promise",
  "unsafe_legal_admission",
  "unsafe_escalation_language",
  "fabricated_order_detail",
  "fabricated_shipping_update",
  "fabricated_timeline",
  "fabricated_tracking_information",
  "fabricated_inventory_promise",
  "category_mismatch",
  "empty_draft",
  "draft_too_long",
  "malformed_json",
  "body_truncated",
] as const;
const SENSITIVE_REVIEW_CATEGORIES = new Set([
  "refund_request",
  "return_request",
  "cancellation_request",
  "item_not_received",
  "item_not_as_described",
  "payment_issue",
  "account_security",
]);
const HIGH_CAUTION_DRAFT_CATEGORIES = new Set([
  "refund_request",
  "chargeback",
  "item_not_received",
  "item_not_as_described",
  "account_security",
  "payment_issue",
]);
const REVIEW_SAFETY_FLAGS = new Set(["low_confidence", "account_security", "payment_or_refund"]);
const REFUND_RISK_CATEGORIES = new Set([
  "refund_request",
  "return_request",
  "cancellation_request",
  "item_not_received",
  "item_not_as_described",
  "payment_issue",
]);
const ACTIVE_JOB_STATUSES = ["queued", "running"];
const ENTITY_KEYS = ["order_numbers", "item_numbers", "buyer_usernames", "tracking_numbers"] as const;
const REQUIRED_OUTPUT_FIELDS = [
  "category",
  "subcategory",
  "priority",
  "urgency",
  "priority_level",
  "urgency_level",
  "response_timing",
  "customer_risk",
  "refund_risk",
  "chargeback_risk",
  "response_needed",
  "human_review_required",
  "confidence",
  "summary",
  "recommended_action",
  "detected_entities",
  "reasoning_summary",
  "safety_flags",
];
const TRANSIENT_OPENAI_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

type ServiceClient = ReturnType<typeof createClient>;
type Mode = typeof SUPPORTED_MODES[number];
type ProcessingJob = {
  id: string;
  message_id: string;
  status: string;
  attempt_count: number | null;
  max_attempts: number | null;
  input_version: string | null;
};
type ClassifierInput = {
  message: Record<string, unknown>;
  participants: Array<Record<string, unknown>>;
  deterministic_links: Array<Record<string, unknown>>;
  body: {
    source: "normalized_text" | "body_text" | "body_preview" | "none";
    text: string;
    body_truncated: boolean;
    body_chars_original: number;
    body_chars_sent: number;
    truncation_strategy: string;
  };
  classifier_context: {
    classifier_name: string;
    classifier_version: string;
    taxonomy_version: string;
    link_context_version: string;
    prompt_version: string;
  };
};
type ValidClassification = {
  category: string;
  subcategory: string | null;
  priority: string;
  urgency: string;
  priority_level: string;
  urgency_level: string;
  response_timing: string;
  customer_risk: string;
  refund_risk: boolean;
  chargeback_risk: boolean;
  response_needed: boolean;
  human_review_required: boolean;
  confidence: number;
  summary: string;
  recommended_action: string;
  detected_entities: Record<string, string[]>;
  reasoning_summary: string;
  safety_flags: string[];
};
type ResponseDraftInput = {
  message: ClassifierInput["message"];
  participants: ClassifierInput["participants"];
  deterministic_links: ClassifierInput["deterministic_links"];
  body: ClassifierInput["body"];
  classification: {
    id: string;
    category: string;
    subcategory: string | null;
    priority: string | null;
    urgency: string | null;
    priority_level: string | null;
    urgency_level: string | null;
    response_timing: string | null;
    customer_risk: string | null;
    refund_risk: boolean;
    chargeback_risk: boolean;
    response_needed: boolean | null;
    recommended_action: string | null;
    requires_human_review: boolean;
    safety_flags: string[];
    summary: string | null;
    reasoning_summary: string | null;
    validation_status: string | null;
    classification_review_state: string;
    operator_notes: string | null;
    effective_category: string;
    effective_priority: string | null;
    effective_urgency: string | null;
    has_operator_override: boolean;
  };
  draft_context: {
    generator_name: string;
    generator_version: string;
    prompt_version: string;
    taxonomy_version: string;
    link_context_version: string;
    verified_order_context_version: string;
    safety_policy_version: string;
  };
  verified_order_context: {
    context_version: string;
    known: {
      order: Array<Record<string, unknown>>;
      order_lines: Array<Record<string, unknown>>;
      shipping: Array<Record<string, unknown>>;
      return_case: Array<Record<string, unknown>>;
      tasks: Array<Record<string, unknown>>;
    };
    unknown: string[];
    do_not_claim: string[];
    summary: {
      verified_context_used: boolean;
      injected_categories: string[];
      order_context_existed: boolean;
      return_context_existed: boolean;
      shipping_context_existed: boolean;
      order_line_context_existed: boolean;
      task_context_existed: boolean;
    };
  };
};
type ValidResponseDraft = {
  category: string;
  draft_subject: string;
  draft_body_text: string;
  tone: string;
  response_strategy: string;
  requires_human_review: boolean;
  safety_flags: string[];
  validation_status: "valid";
};
type ValidationMetadata = {
  hallucination_guard?: {
    removed_entities: number;
  };
  safety_overrides?: string[];
};
type Counters = {
  jobs_enqueued: number;
  jobs_processed: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_skipped: number;
  classifications_created: number;
};
type DryRunCounters = {
  messages_tested: number;
  valid_outputs: number;
  invalid_outputs: number;
  would_classify: number;
};
type Input = {
  mode: Mode;
  limit: number;
  classificationLimit: number;
  replayLimit: number;
  failedJobLimit: number;
  messageId: string | null;
  mailboxId: string | null;
  startDate: string | null;
  endDate: string | null;
  classificationRunId: string | null;
  reason: string;
  replaySource: string;
  idempotencyKey: string | null;
  classificationId: string | null;
  linkId: string | null;
  draftId: string | null;
  includeDraftBody: boolean;
  reviewState: string | null;
  overrideCategory: string | null;
  overridePriority: string | null;
  overrideUrgency: string | null;
  operatorNotes: string | null;
  draftSubject: string | null;
  draftBodyText: string | null;
};

class ClassifierError extends Error {
  code: string;
  status: number;
  phase: string;
  transient: boolean;
  validationErrors: string[];
  jobId?: string;
  messageId?: string;

  constructor(
    code: string,
    options: {
      status?: number;
      phase?: string;
      transient?: boolean;
      validationErrors?: string[];
      jobId?: string;
      messageId?: string;
    } = {},
  ) {
    super(code);
    this.name = "ClassifierError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "classify";
    this.transient = options.transient === true;
    this.validationErrors = options.validationErrors || [];
    this.jobId = options.jobId;
    this.messageId = options.messageId;
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
      "Content-Type": "application/json",
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

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient) {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new ClassifierError("unauthorized", { status: 401, phase: "auth" });

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

  return { userId: user.id, email: user.email || null };
}

async function parseInput(req: Request): Promise<Input> {
  const body = await req.json().catch(() => ({}));
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  const mode = SUPPORTED_MODES.includes(requestedMode as Mode) ? requestedMode as Mode : "enqueue_and_process";
  const limit = Math.min(Math.max(Number(body?.limit) || 25, 1), MAX_LIMIT);
  const classificationLimit = Math.min(Math.max(Number(body?.classificationLimit) || 20, 1), MAX_LIMIT);
  const replayLimit = Math.min(Math.max(Number(body?.replayLimit) || 20, 1), MAX_LIMIT);
  const failedJobLimit = Math.min(Math.max(Number(body?.failedJobLimit) || 20, 1), MAX_LIMIT);
  const messageId = typeof body?.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : null;
  const mailboxId = typeof body?.mailboxId === "string" && body.mailboxId.trim() ? body.mailboxId.trim() : null;
  const startDate = typeof body?.startDate === "string" && body.startDate.trim() ? body.startDate.trim() : null;
  const endDate = typeof body?.endDate === "string" && body.endDate.trim() ? body.endDate.trim() : null;
  const classificationRunId = typeof body?.classificationRunId === "string" && body.classificationRunId.trim()
    ? body.classificationRunId.trim()
    : null;
  const reason = shortText(body?.reason, 500);
  const replaySource = shortText(body?.replaySource || "microsoft-email-classify", 120) || "microsoft-email-classify";
  const idempotencyKey = typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim().slice(0, 200)
    : null;
  const classificationId = typeof body?.classificationId === "string" && body.classificationId.trim()
    ? body.classificationId.trim()
    : null;
  const linkId = typeof body?.linkId === "string" && body.linkId.trim()
    ? body.linkId.trim()
    : null;
  const draftId = typeof body?.draftId === "string" && body.draftId.trim()
    ? body.draftId.trim()
    : null;
  const includeDraftBody = body?.includeDraftBody === true;
  const reviewState = REVIEW_STATES.includes(body?.reviewState)
    ? String(body.reviewState)
    : null;
  const overrideCategory = CATEGORIES.includes(body?.overrideCategory)
    ? String(body.overrideCategory)
    : null;
  const overridePriority = PRIORITIES.includes(body?.overridePriority)
    ? String(body.overridePriority)
    : null;
  const overrideUrgency = URGENCIES.includes(body?.overrideUrgency)
    ? String(body.overrideUrgency)
    : null;
  const operatorNotes = typeof body?.operatorNotes === "string" ? shortText(body.operatorNotes, 2000) : null;
  const draftSubject = typeof body?.draftSubject === "string"
    ? shortText(body.draftSubject, MAX_DRAFT_SUBJECT_CHARS)
    : null;
  const draftBodyText = typeof body?.draftBodyText === "string"
    ? safeBodyText(body.draftBodyText).slice(0, MAX_DRAFT_BODY_CHARS)
    : null;
  if (mode === "process_message" && !messageId) {
    throw new ClassifierError("message_id_required", { status: 400, phase: "input" });
  }
  if (mode === "message_detail" && !messageId) {
    throw new ClassifierError("message_id_required", { status: 400, phase: "input" });
  }
  if ((mode === "admin_context_view" || mode === "operator_match_context") && !messageId) {
    throw new ClassifierError("message_id_required", { status: 400, phase: "input" });
  }
  if ((mode === "confirm_match" || mode === "reject_match" || mode === "mark_match_stale") && !linkId) {
    throw new ClassifierError("link_id_required", { status: 400, phase: "input" });
  }
  if (mode === "reject_match" && !reason) {
    throw new ClassifierError("reason_required", { status: 400, phase: "input" });
  }
  if (mode === "save_review" && !classificationId) {
    throw new ClassifierError("classification_id_required", { status: 400, phase: "input" });
  }
  if (mode === "save_review" && !reviewState) {
    throw new ClassifierError("review_state_required", { status: 400, phase: "input" });
  }
  if (mode === "generate_response" && !messageId && !classificationId) {
    throw new ClassifierError("response_draft_selector_required", { status: 400, phase: "input" });
  }
  if (mode === "regenerate_response" && !messageId && !classificationId && !draftId) {
    throw new ClassifierError("response_draft_selector_required", { status: 400, phase: "input" });
  }
  if ((mode === "save_draft_review" || mode === "approve_draft" || mode === "reject_draft") && !draftId) {
    throw new ClassifierError("draft_id_required", { status: 400, phase: "input" });
  }
  if (mode === "save_draft_review" && !draftSubject) {
    throw new ClassifierError("draft_subject_required", { status: 400, phase: "input" });
  }
  if (mode === "save_draft_review" && !draftBodyText) {
    throw new ClassifierError("draft_body_required", { status: 400, phase: "input" });
  }
  if (mode === "dry_run" && !messageId && !mailboxId) {
    throw new ClassifierError("dry_run_selector_required", { status: 400, phase: "input" });
  }
  if (mode === "replay_classification" && !reason) {
    throw new ClassifierError("reason_required", { status: 400, phase: "input" });
  }
  if (mode === "replay_classification" && !messageId && !mailboxId && !classificationRunId) {
    throw new ClassifierError("replay_selector_required", { status: 400, phase: "input" });
  }
  return {
    mode,
    limit,
    classificationLimit,
    replayLimit,
    failedJobLimit,
    messageId,
    mailboxId,
    startDate,
    endDate,
    classificationRunId,
    reason,
    replaySource,
    idempotencyKey,
    classificationId,
    linkId,
    draftId,
    includeDraftBody,
    reviewState,
    overrideCategory,
    overridePriority,
    overrideUrgency,
    operatorNotes,
    draftSubject,
    draftBodyText,
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

function cleanWhitespace(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shortText(value: unknown, maxLength: number) {
  return cleanWhitespace(value).slice(0, maxLength);
}

function safeBodyText(value: unknown) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function capMessageDetailBody(value: unknown, maxLength = MESSAGE_DETAIL_BODY_CHAR_LIMIT) {
  const text = safeBodyText(value);
  const original = text.length;
  const capped = text.slice(0, maxLength);
  return {
    text: capped,
    body_truncated: original > capped.length,
    body_chars_original: original,
    body_chars_returned: capped.length,
  };
}

function uniqueStrings(values: unknown[], maxItems = 20) {
  return [...new Set(values.map((value) => cleanWhitespace(value)).filter(Boolean))].slice(0, maxItems);
}

function promptVersion() {
  return requiredEnv("EMAIL_CLASSIFIER_PROMPT_VERSION");
}

function modelName() {
  return requiredEnv("OPENAI_EMAIL_CLASSIFIER_MODEL");
}

function responseDraftPromptVersion() {
  return Deno.env.get("EMAIL_RESPONSE_DRAFT_PROMPT_VERSION")?.trim() || RESPONSE_DRAFT_PROMPT_VERSION_DEFAULT;
}

function responseDraftModelName() {
  return Deno.env.get("OPENAI_EMAIL_RESPONSE_DRAFT_MODEL")?.trim() || modelName();
}

function maxBodyChars() {
  const configured = Number(requiredEnv("EMAIL_CLASSIFIER_MAX_BODY_CHARS"));
  if (!Number.isFinite(configured)) {
    throw new ClassifierError("configuration_error", { phase: "configuration" });
  }
  return Math.min(Math.max(configured, 4000), 20000);
}

function buildPrompt(version: string) {
  return `
You are an email classification engine for OG eBay operations.
Return strict JSON only. Do not include markdown, prose, or chain-of-thought.
Classification is advisory only. Do not recommend sending email automatically or changing orders, inventory, sales, Outlook, or eBay records.

Allowed category values: ${CATEGORIES.join(", ")}.
Allowed priority values: ${PRIORITIES.join(", ")}.
Allowed urgency values: ${URGENCIES.join(", ")}.
Allowed priority_level values: ${PRIORITY_LEVELS.join(", ")}.
Allowed urgency_level values: ${URGENCY_LEVELS.join(", ")}.
Allowed response_timing values: ${RESPONSE_TIMINGS.join(", ")}.
Allowed customer_risk values: ${CUSTOMER_RISKS.join(", ")}.
Allowed recommended_action values: ${RECOMMENDED_ACTIONS.join(", ")}.
Allowed safety_flags values: ${SAFETY_FLAGS.join(", ")}.

Use only the supplied stored email context. Do not infer facts that are not supported.
Set human_review_required true for low confidence, ambiguity, account security, refunds, returns, cancellations, item-not-received, item-not-as-described, payment issues, or order-impacting decisions.
If confidence is below 0.60, use category "internal_or_other", recommended_action "review_only", human_review_required true, and include "low_confidence" in safety_flags.
Add workflow metadata for operator triage only. Consider buyer anger, refund requests, threat language, chargeback language, delivery disputes, and time sensitivity.
Use priority_level "critical" and urgency_level "immediate" for chargeback threats, legal/threatening language, account security, or severe order-risk situations.
Use priority_level "high" and urgency_level "today" for angry buyers, refund/return disputes, item-not-received, item-not-as-described, or time-sensitive delivery issues.
Use priority_level "low", urgency_level "low", and response_timing "no_response_needed" for shipping labels, routine notices, marketing, spam, and informational messages that do not need an operator response.
Set refund_risk true only when a refund, return, cancellation, payment dispute, item-not-received, or item-not-as-described issue is present. Set chargeback_risk true only when chargeback, payment dispute escalation, bank/card dispute, or similar threat language is present.
Keep summary and reasoning_summary short. reasoning_summary must be a concise reason, not hidden reasoning.

Prompt version: ${version}.
`.trim();
}

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "subcategory",
      "priority",
      "urgency",
      "priority_level",
      "urgency_level",
      "response_timing",
      "customer_risk",
      "refund_risk",
      "chargeback_risk",
      "response_needed",
      "human_review_required",
      "confidence",
      "summary",
      "recommended_action",
      "detected_entities",
      "reasoning_summary",
      "safety_flags",
    ],
    properties: {
      category: { type: "string", enum: CATEGORIES },
      subcategory: { type: ["string", "null"], maxLength: 80 },
      priority: { type: "string", enum: PRIORITIES },
      urgency: { type: "string", enum: URGENCIES },
      priority_level: { type: "string", enum: PRIORITY_LEVELS },
      urgency_level: { type: "string", enum: URGENCY_LEVELS },
      response_timing: { type: "string", enum: RESPONSE_TIMINGS },
      customer_risk: { type: "string", enum: CUSTOMER_RISKS },
      refund_risk: { type: "boolean" },
      chargeback_risk: { type: "boolean" },
      response_needed: { type: "boolean" },
      human_review_required: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string", maxLength: 280 },
      recommended_action: { type: "string", enum: RECOMMENDED_ACTIONS },
      detected_entities: {
        type: "object",
        additionalProperties: false,
        required: ENTITY_KEYS,
        properties: Object.fromEntries(ENTITY_KEYS.map((key) => [key, {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
        }])),
      },
      reasoning_summary: { type: "string", maxLength: 280 },
      safety_flags: {
        type: "array",
        items: { type: "string", enum: SAFETY_FLAGS },
        maxItems: SAFETY_FLAGS.length,
      },
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

function truncateBody(sourceText: string, budget: number) {
  const text = cleanWhitespace(sourceText);
  const original = text.length;
  const headChars = Math.min(HEAD_CHARS, Math.max(budget - TAIL_CHARS, 2000));
  const tailChars = Math.min(TAIL_CHARS, Math.max(budget - headChars, 0));
  if (original <= budget) {
    return {
      text,
      body_truncated: false,
      body_chars_original: original,
      body_chars_sent: text.length,
      truncation_strategy: TRUNCATION_VERSION,
    };
  }

  const head = text.slice(0, headChars).trim();
  const tail = tailChars > 0 ? text.slice(-tailChars).trim() : "";
  const truncated = tail ? `${head}\n\n[TRUNCATED_BODY_TAIL]\n\n${tail}` : head;
  return {
    text: truncated,
    body_truncated: true,
    body_chars_original: original,
    body_chars_sent: truncated.length,
    truncation_strategy: TRUNCATION_VERSION,
  };
}

async function loadClassifierInput(supabase: ServiceClient, messageId: string, promptVersionValue: string): Promise<ClassifierInput> {
  const { data: message, error: messageError } = await supabase
    .from("email_messages")
    .select("id, mailbox_id, provider, subject, subject_normalized, from_name, from_email, sender_name, sender_email, reply_to_emails, received_at, sent_at, importance, inference_classification, is_read, is_draft, has_attachments, body_preview, sync_status")
    .eq("id", messageId)
    .maybeSingle();

  if (messageError) throw new ClassifierError("message_lookup_failed", { phase: "message_lookup", messageId });
  if (!message?.id) throw new ClassifierError("message_not_found", { status: 404, phase: "message_lookup", messageId });
  if (message.sync_status !== "active") {
    throw new ClassifierError("message_not_active", { status: 400, phase: "message_lookup", messageId });
  }

  const { data: body, error: bodyError } = await supabase
    .from("email_message_bodies")
    .select("body_text, normalized_text, normalized_text_sha256, body_text_sha256, normalization_version, redaction_status")
    .eq("message_id", messageId)
    .maybeSingle();
  if (bodyError) throw new ClassifierError("body_lookup_failed", { phase: "body_lookup", messageId });

  const { data: recipients, error: recipientsError } = await supabase
    .from("email_message_recipients")
    .select("recipient_type, display_name, email_normalized, position")
    .eq("message_id", messageId)
    .order("position", { ascending: true });
  if (recipientsError) throw new ClassifierError("recipient_lookup_failed", { phase: "recipient_lookup", messageId });

  const { data: links, error: linksError } = await supabase
    .from("email_message_links")
    .select("link_type, matched_value, match_method, confidence, status, ebay_order_id, ebay_order_line_id, item_id, sale_id, metadata, created_at")
    .eq("message_id", messageId)
    .in("status", ["suggested", "confirmed"])
    .order("confidence", { ascending: false, nullsFirst: false })
    .limit(20);
  if (linksError) throw new ClassifierError("link_lookup_failed", { phase: "link_lookup", messageId });

  const sourceText = body?.normalized_text || body?.body_text || message.body_preview || "";
  const source = body?.normalized_text ? "normalized_text" : body?.body_text ? "body_text" : message.body_preview ? "body_preview" : "none";
  const truncated = truncateBody(sourceText, maxBodyChars());

  return {
    message: {
      id: message.id,
      mailbox_id: message.mailbox_id,
      provider: message.provider,
      subject: shortText(message.subject, 300),
      subject_normalized: shortText(message.subject_normalized, 300),
      from_name: shortText(message.from_name, 120),
      from_email: shortText(message.from_email, 180).toLowerCase(),
      sender_name: shortText(message.sender_name, 120),
      sender_email: shortText(message.sender_email, 180).toLowerCase(),
      reply_to_emails: uniqueStrings(message.reply_to_emails || [], 10),
      received_at: message.received_at,
      sent_at: message.sent_at,
      importance: message.importance,
      inference_classification: message.inference_classification,
      is_read: message.is_read,
      is_draft: message.is_draft,
      has_attachments: message.has_attachments,
      body_preview: shortText(message.body_preview, 800),
    },
    participants: (recipients || []).slice(0, 50).map((recipient: Record<string, unknown>) => ({
      type: recipient.recipient_type,
      display_name: shortText(recipient.display_name, 120),
      email: shortText(recipient.email_normalized, 180).toLowerCase(),
      position: recipient.position,
    })),
    deterministic_links: (links || []).map((link: Record<string, any>) => ({
      link_type: link.link_type,
      status: link.status,
      confidence: Number(link.confidence || 0),
      match_method: link.match_method,
      matched_value: shortText(link.matched_value, 120),
      has_ebay_order: Boolean(link.ebay_order_id),
      has_ebay_order_line: Boolean(link.ebay_order_line_id),
      has_inventory_item: Boolean(link.item_id),
      has_sale: Boolean(link.sale_id),
      ambiguity: link.metadata?.ambiguity && typeof link.metadata.ambiguity === "object"
        ? Object.keys(link.metadata.ambiguity).slice(0, 20)
        : [],
    })),
    body: {
      source,
      text: truncated.text,
      body_truncated: truncated.body_truncated,
      body_chars_original: truncated.body_chars_original,
      body_chars_sent: truncated.body_chars_sent,
      truncation_strategy: truncated.truncation_strategy,
    },
    classifier_context: {
      classifier_name: CLASSIFIER_NAME,
      classifier_version: CLASSIFIER_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
      link_context_version: LINK_CONTEXT_VERSION,
      prompt_version: promptVersionValue,
    },
  };
}

async function existingValidClassification(supabase: ServiceClient, messageId: string, inputHash: string) {
  const { data, error } = await supabase
    .from("email_message_classifications")
    .select("id")
    .eq("message_id", messageId)
    .eq("source", "ai")
    .eq("classifier_name", CLASSIFIER_NAME)
    .eq("classifier_version", CLASSIFIER_VERSION)
    .eq("input_hash", inputHash)
    .eq("validation_status", "valid")
    .limit(1)
    .maybeSingle();

  if (error) throw new ClassifierError("classification_lookup_failed", { phase: "idempotency_lookup", messageId });
  return data?.id ? String(data.id) : null;
}

function groundingText(input: ClassifierInput) {
  const pieces = [
    stableStringify(input.message),
    stableStringify(input.participants),
    stableStringify(input.deterministic_links),
    input.body.text,
  ];
  return cleanWhitespace(pieces.join(" ")).toLowerCase();
}

function entityIsGrounded(entity: string, haystack: string) {
  const normalized = cleanWhitespace(entity).toLowerCase();
  if (!normalized) return false;
  return haystack.includes(normalized);
}

function enforceSafetyAndGrounding(classification: ValidClassification, input: ClassifierInput) {
  const metadata: ValidationMetadata = {};
  const safetyFlags = new Set(classification.safety_flags);
  const overrides = new Set<string>();

  if (classification.confidence < 0.75) {
    safetyFlags.add("low_confidence");
    classification.human_review_required = true;
    overrides.add("low_confidence_review");
  }
  if (SENSITIVE_REVIEW_CATEGORIES.has(classification.category)) {
    classification.human_review_required = true;
    overrides.add("sensitive_category_review");
  }
  for (const flag of safetyFlags) {
    if (REVIEW_SAFETY_FLAGS.has(flag)) {
      classification.human_review_required = true;
      overrides.add("safety_flag_review");
    }
  }
  if (classification.category === "account_security") {
    classification.recommended_action = "security_review";
    safetyFlags.add("account_security");
    classification.priority_level = "critical";
    classification.urgency_level = "immediate";
    classification.response_timing = "immediate_attention";
    classification.customer_risk = "critical";
    overrides.add("account_security_action");
  } else if (classification.confidence < 0.6 || classification.category === "internal_or_other") {
    classification.recommended_action = "review_only";
    classification.human_review_required = true;
    overrides.add("poor_confidence_review_only");
  }
  if (REFUND_RISK_CATEGORIES.has(classification.category)) {
    classification.refund_risk = true;
    safetyFlags.add("payment_or_refund");
    if (classification.priority_level === "low") classification.priority_level = "high";
    if (classification.urgency_level === "low") classification.urgency_level = "today";
    if (classification.response_timing === "no_response_needed") classification.response_timing = "within_24_hours";
    overrides.add("refund_risk_workflow");
  }
  if (classification.chargeback_risk) {
    classification.priority_level = "critical";
    classification.urgency_level = "immediate";
    classification.response_timing = "immediate_attention";
    classification.customer_risk = "critical";
    classification.human_review_required = true;
    safetyFlags.add("payment_or_refund");
    overrides.add("chargeback_risk_workflow");
  }
  if (classification.response_timing === "immediate_attention") {
    classification.urgency_level = "immediate";
  } else if (classification.response_timing === "within_24_hours" && classification.urgency_level === "low") {
    classification.urgency_level = "today";
  } else if (classification.response_timing === "no_response_needed") {
    classification.response_needed = false;
  }
  if (classification.priority_level === "critical" || classification.urgency_level === "immediate") {
    classification.human_review_required = true;
  }

  const haystack = groundingText(input);
  let removedEntities = 0;
  for (const key of ENTITY_KEYS) {
    const values = classification.detected_entities[key] || [];
    const grounded = values.filter((value) => entityIsGrounded(value, haystack));
    removedEntities += values.length - grounded.length;
    classification.detected_entities[key] = grounded;
  }
  if (removedEntities > 0) {
    safetyFlags.add("hallucinated_entity_removed");
    metadata.hallucination_guard = { removed_entities: removedEntities };
  }

  classification.safety_flags = [...safetyFlags].filter((flag) => SAFETY_FLAGS.includes(flag as typeof SAFETY_FLAGS[number]));
  if (overrides.size) metadata.safety_overrides = [...overrides];
  return { classification, metadata };
}

function validateClassification(
  value: unknown,
  input: ClassifierInput,
): { ok: true; value: ValidClassification; metadata: ValidationMetadata } | { ok: false; errors: string[]; safeOutput: Record<string, unknown> | null } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["output_not_object"], safeOutput: null };
  }
  const row = value as Record<string, unknown>;
  for (const field of REQUIRED_OUTPUT_FIELDS) {
    if (!(field in row)) errors.push("missing_required_field");
  }
  const category = String(row.category || "");
  const priority = String(row.priority || "");
  const urgency = String(row.urgency || "");
  const priorityLevel = String(row.priority_level || "");
  const urgencyLevel = String(row.urgency_level || "");
  const responseTiming = String(row.response_timing || "");
  const customerRisk = String(row.customer_risk || "");
  const recommendedAction = String(row.recommended_action || "");
  const confidence = Number(row.confidence);
  const summary = cleanWhitespace(row.summary);
  const reasoningSummary = cleanWhitespace(row.reasoning_summary);
  const detected = row.detected_entities && typeof row.detected_entities === "object" && !Array.isArray(row.detected_entities)
    ? row.detected_entities as Record<string, unknown>
    : null;
  const safetyFlags = Array.isArray(row.safety_flags) ? row.safety_flags.map((flag) => String(flag || "")) : null;

  if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) errors.push("invalid_category");
  if (!PRIORITIES.includes(priority as typeof PRIORITIES[number])) errors.push("invalid_priority");
  if (!URGENCIES.includes(urgency as typeof URGENCIES[number])) errors.push("invalid_urgency");
  if (!PRIORITY_LEVELS.includes(priorityLevel as typeof PRIORITY_LEVELS[number])) errors.push("invalid_priority_level");
  if (!URGENCY_LEVELS.includes(urgencyLevel as typeof URGENCY_LEVELS[number])) errors.push("invalid_urgency_level");
  if (!RESPONSE_TIMINGS.includes(responseTiming as typeof RESPONSE_TIMINGS[number])) errors.push("invalid_response_timing");
  if (!CUSTOMER_RISKS.includes(customerRisk as typeof CUSTOMER_RISKS[number])) errors.push("invalid_customer_risk");
  if (!RECOMMENDED_ACTIONS.includes(recommendedAction as typeof RECOMMENDED_ACTIONS[number])) errors.push("invalid_recommended_action");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push("invalid_confidence");
  if (row.subcategory !== null && typeof row.subcategory !== "string") errors.push("invalid_subcategory");
  if (!summary || summary.length > 280) errors.push("invalid_summary");
  if (!reasoningSummary || reasoningSummary.length > 280) errors.push("invalid_reasoning_summary");
  if (!detected) errors.push("invalid_detected_entities");
  if (!safetyFlags) errors.push("invalid_safety_flags");

  const detectedEntities: Record<string, string[]> = {};
  if (detected) {
    for (const key of Object.keys(detected)) {
      if (!ENTITY_KEYS.includes(key as typeof ENTITY_KEYS[number])) errors.push("invalid_detected_entities_key");
    }
    for (const key of ENTITY_KEYS) {
      const values = detected[key];
      if (!Array.isArray(values)) errors.push(`invalid_detected_entities_${key}`);
      if (Array.isArray(values) && values.some((value) => typeof value !== "string")) {
        errors.push(`invalid_detected_entities_${key}`);
      }
      detectedEntities[key] = Array.isArray(values) ? uniqueStrings(values, 20) : [];
    }
  }
  const normalizedSafetyFlags = uniqueStrings(safetyFlags || [], SAFETY_FLAGS.length);
  for (const flag of normalizedSafetyFlags) {
    if (!SAFETY_FLAGS.includes(flag as typeof SAFETY_FLAGS[number])) errors.push("invalid_safety_flag");
  }

  const responseNeeded = row.response_needed;
  const refundRisk = row.refund_risk;
  const chargebackRisk = row.chargeback_risk;
  const humanReviewRequired = row.human_review_required;
  if (typeof responseNeeded !== "boolean") errors.push("invalid_response_needed");
  if (typeof refundRisk !== "boolean") errors.push("invalid_refund_risk");
  if (typeof chargebackRisk !== "boolean") errors.push("invalid_chargeback_risk");
  if (typeof humanReviewRequired !== "boolean") errors.push("invalid_human_review_required");

  const subcategory = row.subcategory === null ? null : cleanWhitespace(row.subcategory).slice(0, 80) || null;
  const safeOutput = {
    category,
    subcategory,
    priority,
    urgency,
    priority_level: priorityLevel,
    urgency_level: urgencyLevel,
    response_timing: responseTiming,
    customer_risk: customerRisk,
    refund_risk: refundRisk === true,
    chargeback_risk: chargebackRisk === true,
    response_needed: responseNeeded === true,
    human_review_required: humanReviewRequired !== false,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    summary: summary.slice(0, 280),
    recommended_action: recommendedAction,
    detected_entities: detectedEntities,
    reasoning_summary: reasoningSummary.slice(0, 280),
    safety_flags: normalizedSafetyFlags.filter((flag) => SAFETY_FLAGS.includes(flag as typeof SAFETY_FLAGS[number])),
  };

  if (errors.length) return { ok: false, errors: [...new Set(errors)], safeOutput };
  const hardened = enforceSafetyAndGrounding(safeOutput as ValidClassification, input);
  return { ok: true, value: hardened.classification, metadata: hardened.metadata };
}

async function callOpenAI(input: ClassifierInput, prompt: string, model: string) {
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
            name: "email_triage_classification",
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
      });
    }

    const payload = await response.json().catch(() => null);
    const outputText = extractOutputText(payload);
    if (!outputText) throw new ClassifierError("openai_empty_output", { phase: "openai_parse" });
    const parsed = JSON.parse(outputText);
    return parsed;
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

function buildResponseDraftPrompt(version: string) {
  return `
You are a response draft assistant for OG eBay operations.
Return strict JSON only. Do not include markdown wrappers, prose outside JSON, or chain-of-thought.
Generated drafts are internal suggestions only. They must always require human review. Never instruct the operator to send automatically.

Drafting style:
- Be calm, operational, professional, conservative, non-legalistic, non-accusatory, and uncertainty-aware.
- Prefer short review-oriented replies over confident explanations when facts are missing.
- Acknowledge the buyer's concern without confirming facts that are not verified.
- Avoid emotional language, overconfidence, fabricated certainty, refund promises, shipping promises, inventory promises, and exact timelines.

VERIFIED FACTS:
- Use only the supplied stored email context, deterministic links, effective classification, and verified_order_context.
- You may state a DB fact only when the exact fact is present under verified_order_context.known.
- If verified_order_context.known contains an order field, shipping field, return field, task field, or order line title, you may mention only that exact fact in conservative language.
- Do not upgrade suggested, weak, partial, inferred, or classification-only context into a confirmed customer-facing fact.

UNKNOWN FACTS:
- Treat every entry in verified_order_context.unknown as explicitly missing or unverified.
- When information is unknown, acknowledge uncertainty and use neutral operational language.
- If order details are missing or weak, say "We are reviewing the order details" or "We are reviewing the order associated with your message."
- If tracking is unavailable, say "We do not currently see tracking information in our system" or "Tracking information is not currently available."
- If item identity is only suggested or weak, do not name the item type; say "the order associated with your message."
- If refund or return status is unknown, say "We are reviewing the return/refund request."
- If replacement or inventory status is unknown, say "We are checking item availability."
- If a timeline is unknown, say "We will follow up after confirming the order status" instead of giving a date or shipping estimate.

DO NOT CLAIM:
- Follow every verified_order_context.do_not_claim rule.
- Do not invent order numbers, tracking numbers, carrier movement, delivery status, dates, item type, inventory status, policies, refunds, compensation, or replacement availability.
- Do not say an item shipped, is in transit, is out for delivery, was delivered, has a label, or has tracking unless verified_order_context.known supports that exact fact.
- Do not say a refund, return, cancellation, replacement, discount, store credit, free item, expedited shipping, or compensation is approved, available, issued, processed, guaranteed, or promised unless verified_order_context.known supports that exact fact.
- Do not say "your watch", "your phone", or another item type unless verified order line context strongly identifies that item type.
- Do not promise exact timelines such as today, tomorrow, next business day, ship by, delivered by, or within a number of days unless verified_order_context.known supports that exact timeline.
Do not admit legal fault, policy violations, negligence, counterfeit/authenticity conclusions, or liability.
For refund_request, chargeback, item_not_received, item_not_as_described, account_security, and payment_issue, use cautious review-oriented wording and avoid commitments.

SAFE LANGUAGE EXAMPLES:
- Tracking unavailable: "We do not currently see tracking information associated with this order."
- Order context missing: "We are reviewing the order details and will follow up after confirming the status."
- Weak item identity: "We are reviewing the order associated with your message."
- Refund status unknown: "We are reviewing the return/refund request before confirming next steps."
- Replacement availability unknown: "We are checking item availability before confirming replacement options."
- Shipping timeline unknown: "We will follow up after confirming the order status."

Adapt by effective category:
- return_request: empathetic return workflow, ask operator/buyer to follow verified platform process, no approval promise.
- shipping_label: concise operational acknowledgement, no fabricated shipping update.
- item_not_as_described: cautious escalation-aware response, acknowledge concern, request review/details, no admission.
- refund_request: non-committal review-oriented wording, no refund promise.
- item_not_received: acknowledge delivery concern, say the order/shipping details need review, no delivery guarantee.
- payment_issue/account_security/chargeback: brief, careful, escalate for human review.

Output fields:
- category must equal classification.effective_category.
- draft_subject must be concise and safe.
- draft_body_text must be plain text, no HTML, no signature block, no markdown table.
- tone must be a short label.
- response_strategy must summarize the safe operator strategy in one sentence.
- requires_human_review must be true.
- validation_status must be "valid".
- safety_flags must use allowed values only when applicable.

Allowed category values: ${CATEGORIES.join(", ")}.
Allowed safety_flags values: ${RESPONSE_DRAFT_SAFETY_FLAGS.join(", ")}.
Prompt version: ${version}.
`.trim();
}

function responseDraftJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "draft_subject",
      "draft_body_text",
      "tone",
      "response_strategy",
      "requires_human_review",
      "safety_flags",
      "validation_status",
    ],
    properties: {
      category: { type: "string", enum: CATEGORIES },
      draft_subject: { type: "string", maxLength: MAX_DRAFT_SUBJECT_CHARS },
      draft_body_text: { type: "string", maxLength: MAX_DRAFT_BODY_CHARS },
      tone: { type: "string", maxLength: 80 },
      response_strategy: { type: "string", maxLength: 300 },
      requires_human_review: { type: "boolean" },
      safety_flags: {
        type: "array",
        items: { type: "string", enum: RESPONSE_DRAFT_SAFETY_FLAGS },
        maxItems: RESPONSE_DRAFT_SAFETY_FLAGS.length,
      },
      validation_status: { type: "string", enum: ["valid"] },
    },
  };
}

async function callOpenAIResponseDraft(input: ResponseDraftInput, prompt: string, model: string) {
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
            name: "email_triage_response_draft",
            strict: true,
            schema: responseDraftJsonSchema(),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new ClassifierError("response_draft_openai_request_failed", {
        phase: "response_draft_openai",
        transient: TRANSIENT_OPENAI_STATUSES.has(response.status),
      });
    }

    const payload = await response.json().catch(() => null);
    const outputText = extractOutputText(payload);
    if (!outputText) throw new ClassifierError("response_draft_openai_empty_output", { phase: "response_draft_openai_parse" });
    return JSON.parse(outputText);
  } catch (error) {
    if (error instanceof ClassifierError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ClassifierError("response_draft_openai_timeout", { phase: "response_draft_openai", transient: true });
    }
    if (error instanceof SyntaxError) {
      throw new ClassifierError("response_draft_malformed_json", { phase: "response_draft_validation" });
    }
    throw new ClassifierError("response_draft_openai_network_failure", { phase: "response_draft_openai", transient: true });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function insertClassification(
  supabase: ServiceClient,
  values: {
    messageId: string;
    jobId: string;
    actorId: string;
    prompt: string;
    promptHash: string;
    promptVersion: string;
    inputHash: string;
    inputVersion: string;
    model: string;
    bodyMeta: ClassifierInput["body"];
    classification?: ValidClassification;
    validationStatus: "valid" | "invalid";
    validationErrors: string[];
    rawSafeOutput: Record<string, unknown> | null;
    validationMetadata?: ValidationMetadata;
  },
) {
  const nowIso = new Date().toISOString();
  if (values.validationStatus === "valid") {
    const { error: supersedeError } = await supabase
      .from("email_message_classifications")
      .update({ is_current: false, superseded_at: nowIso })
      .eq("message_id", values.messageId)
      .eq("source", "ai")
      .eq("classifier_name", CLASSIFIER_NAME)
      .eq("is_current", true);
    if (supersedeError) {
      throw new ClassifierError("classification_supersede_failed", { phase: "classification_write", messageId: values.messageId });
    }
  }

  const classification = values.classification || {
    category: "internal_or_other",
    subcategory: "unclassifiable",
    priority: "medium",
    urgency: "none",
    priority_level: "medium",
    urgency_level: "low",
    response_timing: "no_response_needed",
    customer_risk: "medium",
    refund_risk: false,
    chargeback_risk: false,
    response_needed: false,
    human_review_required: true,
    confidence: 0,
    summary: "Classifier output failed validation.",
    recommended_action: "review_only",
    detected_entities: {
      order_numbers: [],
      item_numbers: [],
      buyer_usernames: [],
      tracking_numbers: [],
    },
    reasoning_summary: "The AI output did not pass strict validation.",
    safety_flags: ["low_confidence"],
  };

  const evidence = {
    classifier_version: CLASSIFIER_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
    attempted_input_hash: values.inputHash,
    body_truncated: values.bodyMeta.body_truncated,
    body_chars_original: values.bodyMeta.body_chars_original,
    body_chars_sent: values.bodyMeta.body_chars_sent,
    truncation_strategy: values.bodyMeta.truncation_strategy,
    body_source: values.bodyMeta.source,
    validation_metadata: values.validationMetadata || {},
  };

  const { data, error } = await supabase
    .from("email_message_classifications")
    .insert({
      message_id: values.messageId,
      source: "ai",
      classifier_name: CLASSIFIER_NAME,
      classifier_version: CLASSIFIER_VERSION,
      category: classification.category,
      subcategory: classification.subcategory,
      confidence: classification.confidence,
      priority: classification.priority,
      priority_level: classification.priority_level,
      urgency_level: classification.urgency_level,
      response_timing: classification.response_timing,
      customer_risk: classification.customer_risk,
      refund_risk: classification.refund_risk,
      chargeback_risk: classification.chargeback_risk,
      requires_human_review: classification.human_review_required,
      reasoning_summary: classification.reasoning_summary,
      evidence,
      created_by: values.actorId,
      urgency: classification.urgency,
      response_needed: classification.response_needed,
      recommended_action: classification.recommended_action,
      detected_entities: classification.detected_entities,
      safety_flags: classification.safety_flags,
      summary: classification.summary,
      model_name: values.model,
      model_version: null,
      prompt_version: values.promptVersion,
      prompt_hash: values.promptHash,
      input_hash: values.validationStatus === "valid" ? values.inputHash : null,
      raw_safe_output: values.rawSafeOutput,
      validation_status: values.validationStatus,
      validation_errors: values.validationErrors,
      classification_run_id: crypto.randomUUID(),
      processing_job_id: values.jobId,
      input_version: values.inputVersion,
      classified_at: nowIso,
      is_current: values.validationStatus === "valid",
      superseded_at: values.validationStatus === "valid" ? null : nowIso,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new ClassifierError("classification_insert_failed", { phase: "classification_write", messageId: values.messageId });
  }
  return String(data.id);
}

function classifierInputVersion(promptHash: string) {
  return `${CLASSIFIER_VERSION}:prompt:${promptHash.slice(0, 12)}:${TRUNCATION_VERSION}:${LINK_CONTEXT_VERSION}`;
}

async function enqueueJobs(supabase: ServiceClient, input: Input, promptHash: string) {
  let query = supabase
    .from("email_messages")
    .select("id")
    .eq("sync_status", "active")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(input.limit);
  if (input.messageId) query = query.eq("id", input.messageId);

  const { data: messages, error } = await query;
  if (error) throw new ClassifierError("enqueue_failed", { phase: "message_select" });
  const messageIds = (messages || []).map((message: { id: string }) => message.id);
  if (!messageIds.length) return 0;

  const active = new Set<string>();
  for (let index = 0; index < messageIds.length; index += 100) {
    const { data: activeRows, error: activeError } = await supabase
      .from("email_processing_jobs")
      .select("message_id")
      .in("message_id", messageIds.slice(index, index + 100))
      .eq("job_type", "classify")
      .in("status", ["queued", "running"]);
    if (activeError) throw new ClassifierError("active_job_lookup_failed", { phase: "active_job_lookup" });
    for (const row of activeRows || []) active.add(String(row.message_id));
  }

  const inputVersion = classifierInputVersion(promptHash);
  const rows = messageIds
    .filter((messageId) => !active.has(messageId))
    .map((messageId) => ({
      message_id: messageId,
      job_type: "classify",
      input_version: inputVersion,
      status: "queued",
      priority: 70,
      attempt_count: 0,
      max_attempts: 3,
      available_at: new Date().toISOString(),
      metadata: {
        classifier_name: CLASSIFIER_NAME,
        classifier_version: CLASSIFIER_VERSION,
        prompt_hash: promptHash,
        prompt_version: promptVersion(),
        enqueue_source: "microsoft-email-classify",
      },
    }));

  if (!rows.length) return 0;
  const { data, error: insertError } = await supabase
    .from("email_processing_jobs")
    .upsert(rows, { onConflict: "message_id,job_type,input_version", ignoreDuplicates: true })
    .select("id");
  if (insertError) throw new ClassifierError("enqueue_failed", { phase: "job_insert" });
  return data?.length || 0;
}

async function claimQueuedJobs(supabase: ServiceClient, input: Input) {
  let query = supabase
    .from("email_processing_jobs")
    .select("id, message_id, status, attempt_count, max_attempts, input_version")
    .eq("status", "queued")
    .eq("job_type", "classify")
    .lte("available_at", new Date().toISOString())
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(input.limit);
  if (input.messageId) query = query.eq("message_id", input.messageId);

  const { data, error } = await query;
  if (error) throw new ClassifierError("job_claim_failed", { phase: "job_select" });
  return (data || []) as ProcessingJob[];
}

async function markJob(
  supabase: ServiceClient,
  job: ProcessingJob,
  status: "running" | "queued" | "succeeded" | "failed" | "skipped",
  values: Record<string, unknown> = {},
) {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { status, ...values };
  if (status === "running") {
    patch.started_at = nowIso;
    patch.locked_at = nowIso;
    patch.locked_by = "microsoft-email-classify";
    patch.attempt_count = Number(job.attempt_count || 0) + 1;
  }
  if (status === "queued") {
    patch.locked_at = null;
    patch.locked_by = null;
  }
  if (["succeeded", "failed", "skipped"].includes(status)) {
    patch.completed_at = nowIso;
    patch.locked_at = null;
    patch.locked_by = null;
  }

  let update = supabase.from("email_processing_jobs").update(patch).eq("id", job.id);
  if (status === "running") update = update.eq("status", "queued");
  const { data, error } = await update.select("id").maybeSingle();
  if (error || !data?.id) {
    throw new ClassifierError("job_claim_failed", { phase: "job_update", jobId: job.id, messageId: job.message_id });
  }
}

function retryDelaySeconds(attempt: number) {
  return Math.min(60 * Math.max(attempt, 1), 300);
}

function validationDiagnosticCodes(errors: string[]) {
  const diagnostics = new Set<string>();
  for (const error of errors) {
    if (error === "openai_invalid_json") diagnostics.add("invalid_json");
    if (error.startsWith("invalid_")) diagnostics.add(error.replace(/^invalid_/, "invalid_"));
    if (error.includes("required") || error.includes("missing")) diagnostics.add("missing_required_field");
  }
  for (const error of errors) {
    if ([
      "invalid_category",
      "invalid_priority",
      "invalid_urgency",
      "invalid_priority_level",
      "invalid_urgency_level",
      "invalid_response_timing",
      "invalid_customer_risk",
      "invalid_recommended_action",
      "invalid_safety_flag",
    ].includes(error)) {
      diagnostics.add("invalid_enum");
    }
    if (error === "invalid_confidence") diagnostics.add("confidence_out_of_range");
  }
  return [...diagnostics].slice(0, 20);
}

async function processJob(supabase: ServiceClient, job: ProcessingJob, actorId: string, prompt: string, promptHash: string, promptVersionValue: string, model: string) {
  await markJob(supabase, job, "running");
  const nextAttempt = Number(job.attempt_count || 0) + 1;
  const inputVersion = job.input_version || classifierInputVersion(promptHash);

  try {
    const classifierInput = await loadClassifierInput(supabase, job.message_id, promptVersionValue);
    const inputHash = await sha256Hex(stableStringify({
      classifier_name: CLASSIFIER_NAME,
      classifier_version: CLASSIFIER_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
      prompt_hash: promptHash,
      input_version: inputVersion,
      input: classifierInput,
    }));

    const existingId = await existingValidClassification(supabase, job.message_id, inputHash);
    if (existingId) {
      await markJob(supabase, job, "skipped", {
        last_error_code: null,
        last_error_message: null,
        metadata: {
          classifier_name: CLASSIFIER_NAME,
          classifier_version: CLASSIFIER_VERSION,
          prompt_hash: promptHash,
          input_hash: inputHash,
          skip_reason: "existing_valid_classification",
          existing_classification_id: existingId,
        },
      });
      return { status: "skipped" as const, classifications_created: 0 };
    }

    const aiOutput = await callOpenAI(classifierInput, prompt, model);
    const validation = validateClassification(aiOutput, classifierInput);
    if (!validation.ok) {
      await insertClassification(supabase, {
        messageId: job.message_id,
        jobId: job.id,
        actorId,
        prompt,
        promptHash,
        promptVersion: promptVersionValue,
        inputHash,
        inputVersion,
        model,
        bodyMeta: classifierInput.body,
        validationStatus: "invalid",
        validationErrors: validation.errors,
        rawSafeOutput: validation.safeOutput,
      }).catch(() => undefined);
      throw new ClassifierError("classification_validation_failed", {
        phase: "validation",
        validationErrors: validation.errors,
        jobId: job.id,
        messageId: job.message_id,
      });
    }

    await insertClassification(supabase, {
      messageId: job.message_id,
      jobId: job.id,
      actorId,
      prompt,
      promptHash,
      promptVersion: promptVersionValue,
      inputHash,
      inputVersion,
      model,
      bodyMeta: classifierInput.body,
      classification: validation.value,
      validationStatus: "valid",
      validationErrors: [],
      rawSafeOutput: validation.value,
      validationMetadata: validation.metadata,
    });

    await markJob(supabase, job, "succeeded", {
      last_error_code: null,
      last_error_message: null,
      metadata: {
        classifier_name: CLASSIFIER_NAME,
        classifier_version: CLASSIFIER_VERSION,
        prompt_hash: promptHash,
        input_hash: inputHash,
        model_name: model,
        body_truncated: classifierInput.body.body_truncated,
        body_chars_original: classifierInput.body.body_chars_original,
        body_chars_sent: classifierInput.body.body_chars_sent,
        validation_metadata: validation.metadata,
      },
    });
    return { status: "succeeded" as const, classifications_created: 1 };
  } catch (error) {
    const safe = safeError(error, job);
    if (safe.transient && nextAttempt < Number(job.max_attempts || 3)) {
      const availableAt = new Date(Date.now() + retryDelaySeconds(nextAttempt) * 1000).toISOString();
      await markJob(supabase, job, "queued", {
        available_at: availableAt,
        last_error_code: safe.code,
        last_error_message: safe.code,
        metadata: {
          classifier_name: CLASSIFIER_NAME,
          classifier_version: CLASSIFIER_VERSION,
          error: safe.code,
          phase: safe.phase,
          retry_scheduled: true,
          next_attempt: nextAttempt + 1,
        },
      }).catch(() => undefined);
      throw safe;
    }

    await markJob(supabase, job, "failed", {
      last_error_code: safe.code,
      last_error_message: safe.code,
      metadata: {
        classifier_name: CLASSIFIER_NAME,
        classifier_version: CLASSIFIER_VERSION,
        error: safe.code,
        phase: safe.phase,
        validation_errors: safe.validationErrors,
        validation_diagnostics: validationDiagnosticCodes(safe.validationErrors.length ? safe.validationErrors : [safe.code]),
        retryable: safe.transient,
        attempts_exhausted: safe.transient && nextAttempt >= Number(job.max_attempts || 3),
      },
    }).catch(() => undefined);
    throw safe;
  }
}

async function processQueuedJobs(supabase: ServiceClient, input: Input, actorId: string, counters: Counters, prompt: string, promptHash: string, promptVersionValue: string, model: string) {
  const jobs = await claimQueuedJobs(supabase, input);
  for (const job of jobs) {
    try {
      const result = await processJob(supabase, job, actorId, prompt, promptHash, promptVersionValue, model);
      counters.jobs_processed += 1;
      if (result.status === "succeeded") counters.jobs_succeeded += 1;
      if (result.status === "skipped") counters.jobs_skipped += 1;
      counters.classifications_created += result.classifications_created;
    } catch (error) {
      const safe = safeError(error, job);
      counters.jobs_processed += 1;
      counters.jobs_failed += 1;
      console.error("[microsoft-email-classify] job failed", {
        phase: safe.phase,
        error: safe.code,
        job_id: job.id,
        message_id: job.message_id,
      });
    }
  }
}

function blankCounters(): Counters {
  return {
    jobs_enqueued: 0,
    jobs_processed: 0,
    jobs_succeeded: 0,
    jobs_failed: 0,
    jobs_skipped: 0,
    classifications_created: 0,
  };
}

function blankDryRunCounters(): DryRunCounters {
  return {
    messages_tested: 0,
    valid_outputs: 0,
    invalid_outputs: 0,
    would_classify: 0,
  };
}

async function countRows(supabase: ServiceClient, table: string, build: (query: any) => any) {
  const query = build(supabase.from(table).select("id", { count: "exact", head: true }));
  const { count, error } = await query;
  if (error) throw new ClassifierError("admin_view_count_failed", { phase: `${table}_count` });
  return count || 0;
}

function safeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[redacted_depth_limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/(bearer\s+|sk-[a-z0-9_-]{10,}|refresh[_-]?token|access[_-]?token)/i.test(value)) return "[redacted]";
    return shortText(value, 1000);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeMetadata(item, depth + 1));
  if (typeof value !== "object") return null;

  const sensitiveKeyPattern = /(token|secret|api[_-]?key|authorization|credential|password|encrypted)/i;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 80)
      .map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[redacted]" : safeMetadata(item, depth + 1),
      ]),
  );
}

function reviewStateForRow(row: Record<string, any>) {
  const state = String(row.classification_review_state || "pending_review");
  return REVIEW_STATES.includes(state as typeof REVIEW_STATES[number]) ? state : "pending_review";
}

function effectiveClassification(row: Record<string, any>) {
  return {
    effective_category: row.operator_override_category || row.category,
    effective_priority: row.operator_override_priority || row.priority,
    effective_urgency: row.operator_override_urgency || row.urgency,
    has_operator_override: Boolean(row.operator_override_category || row.operator_override_priority || row.operator_override_urgency),
  };
}

function safeArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function normalizedGrounding(input: ResponseDraftInput) {
  return cleanWhitespace([
    stableStringify(input.message),
    stableStringify(input.participants),
    stableStringify(input.deterministic_links),
    stableStringify(input.classification),
    stableStringify(input.verified_order_context),
    input.body.text,
  ].join(" ")).toLowerCase();
}

function containsAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractTrackingLikeTokens(text: string) {
  const tokens = text.match(/\b[A-Z0-9][A-Z0-9 -]{7,34}[A-Z0-9]\b/gi) || [];
  return uniqueStrings(tokens.map((token) => token.replace(/\s+/g, "").replace(/-/g, "")), 20)
    .filter((token) => /\d/.test(token) && token.length >= 8);
}

function validateResponseDraft(
  value: unknown,
  input: ResponseDraftInput,
): { ok: true; value: ValidResponseDraft; validationErrors: string[] } | { ok: false; safeOutput: Partial<ValidResponseDraft>; validationErrors: string[]; safetyFlags: string[] } {
  const errors: string[] = [];
  const safetyFlags = new Set<string>(["requires_human_review"]);
  if (input.body.body_truncated) safetyFlags.add("body_truncated");
  if (SENSITIVE_REVIEW_CATEGORIES.has(input.classification.effective_category) || HIGH_CAUTION_DRAFT_CATEGORIES.has(input.classification.effective_category)) {
    safetyFlags.add("sensitive_category");
  }
  if (input.classification.refund_risk) safetyFlags.add("payment_or_refund");
  if (input.classification.chargeback_risk) safetyFlags.add("chargeback_risk");
  if (input.classification.effective_category === "account_security") safetyFlags.add("account_security");

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      safeOutput: {},
      validationErrors: ["output_not_object", "malformed_json"],
      safetyFlags: [...safetyFlags, "malformed_json"],
    };
  }

  const row = value as Record<string, unknown>;
  const category = String(row.category || "");
  const draftSubject = shortText(row.draft_subject, MAX_DRAFT_SUBJECT_CHARS);
  const draftBodyText = safeBodyText(row.draft_body_text).slice(0, MAX_DRAFT_BODY_CHARS);
  const tone = shortText(row.tone, 80);
  const responseStrategy = shortText(row.response_strategy, 300);
  const requiresHumanReview = row.requires_human_review;
  const validationStatus = String(row.validation_status || "");
  const modelFlags = safeArray(row.safety_flags);

  for (const field of ["category", "draft_subject", "draft_body_text", "tone", "response_strategy", "requires_human_review", "safety_flags", "validation_status"]) {
    if (!(field in row)) errors.push(`missing_${field}`);
  }
  if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) errors.push("invalid_category");
  if (category !== input.classification.effective_category) {
    errors.push("category_mismatch");
    safetyFlags.add("category_mismatch");
  }
  if (!draftSubject) errors.push("empty_draft_subject");
  if (!draftBodyText) {
    errors.push("empty_draft_body");
    safetyFlags.add("empty_draft");
  }
  if (String(row.draft_subject || "").length > MAX_DRAFT_SUBJECT_CHARS) errors.push("draft_subject_too_long");
  if (String(row.draft_body_text || "").length > MAX_DRAFT_BODY_CHARS) {
    errors.push("draft_body_too_long");
    safetyFlags.add("draft_too_long");
  }
  if (!tone) errors.push("invalid_tone");
  if (!responseStrategy) errors.push("invalid_response_strategy");
  if (requiresHumanReview !== true) errors.push("human_review_required_must_be_true");
  if (validationStatus !== "valid") errors.push("invalid_validation_status");
  if (!Array.isArray(row.safety_flags)) errors.push("invalid_safety_flags");
  for (const flag of modelFlags) {
    if (!RESPONSE_DRAFT_SAFETY_FLAGS.includes(flag as typeof RESPONSE_DRAFT_SAFETY_FLAGS[number])) errors.push("invalid_safety_flag");
    else safetyFlags.add(flag);
  }

  const combined = cleanWhitespace(`${draftSubject} ${draftBodyText}`).toLowerCase();
  const verifiedGrounding = cleanWhitespace(stableStringify(input.verified_order_context.known)).toLowerCase();
  const highCaution = HIGH_CAUTION_DRAFT_CATEGORIES.has(input.classification.effective_category) ||
    input.classification.refund_risk ||
    input.classification.chargeback_risk;

  if (containsAny(combined, [
    /\b(i|we|our team|og)\s+(will|can|shall|have)\s+(refund|refunded|issue a refund|send a refund|process a refund)\b/i,
    /\brefund\s+(has been|is approved|is guaranteed|will be issued|will be processed)\b/i,
    /\byou(?:'|’)ll\s+be\s+refunded\b/i,
  ])) {
    errors.push("unsafe_refund_promise");
    safetyFlags.add("unsafe_refund_promise");
    safetyFlags.add("payment_or_refund");
  }
  if (containsAny(combined, [
    /\b(i|we)\s+(will|can|shall)\s+(compensate|reimburse|credit|discount|replace)\b/i,
    /\b(store credit|free replacement|partial refund|full refund|discount)\s+(is|will be|has been)\b/i,
  ])) {
    errors.push("unsafe_compensation_promise");
    safetyFlags.add("unsafe_compensation_promise");
  }
  if (containsAny(combined, [
    /\b(we|i|our team|og)\s+(are|were|am|was)\s+(at fault|liable|responsible|negligent|wrong)\b/i,
    /\b(we|i|our team|og)\s+(violated|broke)\b/i,
    /\bthis was our mistake\b/i,
  ])) {
    errors.push("unsafe_legal_admission");
    safetyFlags.add("unsafe_legal_admission");
    safetyFlags.add("legal_or_policy_risk");
  }
  if (containsAny(combined, [
    /\b(chargeback|legal action|lawsuit|attorney|lawyer|police report)\b/i,
    /\b(escalate this against|report you|take action against)\b/i,
  ])) {
    if (!input.classification.chargeback_risk && input.classification.effective_category !== "account_security") {
      errors.push("unsafe_escalation_language");
      safetyFlags.add("unsafe_escalation_language");
    }
  }
  if (containsAny(combined, [
    /\b(shipped|in transit|out for delivery|delivered|delivery attempted|label created|carrier has|tracking shows)\b/i,
  ]) && !containsAny(verifiedGrounding, [
    /\b(shipped|in transit|out for delivery|delivered|delivery attempted|label created|tracking|carrier)\b/i,
  ])) {
    errors.push("fabricated_shipping_update");
    safetyFlags.add("fabricated_shipping_update");
  }
  if (containsAny(combined, [
    /\b(will arrive|arrives|delivery is expected|delivered by|ship by|ships by|within \d+\s+(business\s+)?days?|today|tomorrow)\b/i,
  ]) && !containsAny(verifiedGrounding, [
    /\b(will arrive|arrives|delivery is expected|delivered by|ship by|ships by|within \d+\s+(business\s+)?days?|today|tomorrow)\b/i,
  ])) {
    errors.push("fabricated_timeline");
    safetyFlags.add("fabricated_timeline");
  }
  if (containsAny(combined, [
    /\b(in stock|available now|reserved for you|we have another|replacement is available|inventory is available)\b/i,
  ]) && !containsAny(verifiedGrounding, [
    /\b(in stock|available|inventory|replacement)\b/i,
  ])) {
    errors.push("fabricated_inventory_promise");
    safetyFlags.add("fabricated_inventory_promise");
  }

  const draftTokens = extractTrackingLikeTokens(`${draftSubject} ${draftBodyText}`);
  for (const token of draftTokens) {
    if (!entityIsGrounded(token, verifiedGrounding)) {
      errors.push("fabricated_tracking_information");
      safetyFlags.add("fabricated_tracking_information");
      break;
    }
  }

  if (containsAny(combined, [/\border\s+#?\s*[a-z0-9-]{5,}/i, /\bitem\s+#?\s*\d{5,}/i]) && !containsAny(verifiedGrounding, [/\border\s+#?\s*[a-z0-9-]{5,}/i, /\bitem\s+#?\s*\d{5,}/i])) {
    errors.push("fabricated_order_detail");
    safetyFlags.add("fabricated_order_detail");
  }
  if (containsAny(combined, [
    /\b(return|return case)\s+(has been|is|was)\s+(approved|accepted|authorized)\b/i,
    /\bwe\s+(approved|accepted|authorized)\s+(your\s+)?return\b/i,
  ]) && !containsAny(verifiedGrounding, [/\b(approved|accepted|authorized)\b/i])) {
    errors.push("unsupported_return_approval_claim");
    safetyFlags.add("unsupported_claim");
  }
  if (containsAny(combined, [
    /\b(refund|return)\s+(has been|is|was)\s+(approved|processed|issued|completed)\b/i,
    /\bwe\s+(approved|processed|issued|completed)\s+(your\s+)?refund\b/i,
  ])) {
    errors.push("unsupported_refund_state_claim");
    safetyFlags.add("unsupported_claim");
    safetyFlags.add("payment_or_refund");
  }
  for (const productType of ["watch", "phone", "laptop", "tablet", "camera", "ring", "necklace", "bracelet", "shoe", "bag", "console"]) {
    if (new RegExp(`\\b${productType}s?\\b`, "i").test(combined) && !new RegExp(`\\b${productType}s?\\b`, "i").test(verifiedGrounding)) {
      errors.push("fabricated_item_type");
      safetyFlags.add("fabricated_order_detail");
      break;
    }
  }
  if (highCaution && containsAny(combined, [/\b(done|approved|guaranteed|definitely|certainly|no problem)\b/i])) {
    errors.push("unsupported_claim");
    safetyFlags.add("unsupported_claim");
  }

  const normalizedFlags = [...safetyFlags].filter((flag) => RESPONSE_DRAFT_SAFETY_FLAGS.includes(flag as typeof RESPONSE_DRAFT_SAFETY_FLAGS[number]));
  const safeOutput = {
    category,
    draft_subject: draftSubject,
    draft_body_text: draftBodyText,
    tone,
    response_strategy: responseStrategy,
    requires_human_review: true,
    safety_flags: normalizedFlags,
    validation_status: "valid" as const,
  };

  if (errors.length) {
    return {
      ok: false,
      safeOutput,
      validationErrors: [...new Set(errors)].slice(0, 40),
      safetyFlags: normalizedFlags,
    };
  }
  return { ok: true, value: safeOutput, validationErrors: [] };
}

function reviewSnapshot(row: Record<string, any>) {
  return {
    classification_review_state: reviewStateForRow(row),
    operator_override_category: row.operator_override_category || null,
    operator_override_priority: row.operator_override_priority || null,
    operator_override_urgency: row.operator_override_urgency || null,
    operator_notes: row.operator_notes || null,
    reviewed_by: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
  };
}

async function saveClassificationReview(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string; email: string | null },
) {
  if (!input.classificationId || !input.reviewState) {
    throw new ClassifierError("invalid_review_input", { status: 400, phase: "review_input" });
  }

  const { data: existing, error: lookupError } = await supabase
    .from("email_message_classifications")
    .select("id, message_id, source, category, priority, urgency, classification_review_state, operator_override_category, operator_override_priority, operator_override_urgency, operator_notes, reviewed_by, reviewed_at")
    .eq("id", input.classificationId)
    .eq("source", "ai")
    .maybeSingle();

  if (lookupError) throw new ClassifierError("review_classification_lookup_failed", { phase: "review_lookup" });
  if (!existing?.id) throw new ClassifierError("classification_not_found", { status: 404, phase: "review_lookup" });

  const hasOverride = Boolean(input.overrideCategory || input.overridePriority || input.overrideUrgency);
  if (input.reviewState === "corrected" && !hasOverride) {
    throw new ClassifierError("correction_requires_override", { status: 400, phase: "review_input" });
  }

  const nowIso = new Date().toISOString();
  const previousState = reviewSnapshot(existing as Record<string, any>);
  const reviewMetadata = {
    original_ai: {
      category: existing.category,
      priority: existing.priority,
      urgency: existing.urgency,
    },
    effective: {
      category: input.overrideCategory || existing.category,
      priority: input.overridePriority || existing.priority,
      urgency: input.overrideUrgency || existing.urgency,
    },
    saved_via: "microsoft-email-classify.save_review",
    saved_at: nowIso,
  };

  const { data: updated, error: updateError } = await supabase
    .from("email_message_classifications")
    .update({
      classification_review_state: input.reviewState,
      operator_override_category: input.overrideCategory,
      operator_override_priority: input.overridePriority,
      operator_override_urgency: input.overrideUrgency,
      operator_notes: input.operatorNotes,
      reviewed_by: admin.userId,
      reviewed_at: nowIso,
      review_metadata: reviewMetadata,
    })
    .eq("id", input.classificationId)
    .eq("source", "ai")
    .select("id, message_id, category, priority, urgency, classification_review_state, operator_override_category, operator_override_priority, operator_override_urgency, operator_notes, reviewed_by, reviewed_at")
    .single();

  if (updateError || !updated?.id) {
    throw new ClassifierError("review_update_failed", { phase: "review_update", messageId: existing.message_id });
  }

  const eventType = input.reviewState === "approved" || input.reviewState === "corrected" || input.reviewState === "dismissed"
    ? input.reviewState
    : "review_saved";
  const { error: auditError } = await supabase
    .from("email_classification_review_events")
    .insert({
      classification_id: input.classificationId,
      message_id: existing.message_id,
      event_type: eventType,
      previous_state: previousState,
      new_state: reviewSnapshot(updated as Record<string, any>),
      notes: input.operatorNotes,
      created_by: admin.userId,
      created_by_email: admin.email,
    });
  if (auditError) throw new ClassifierError("review_audit_insert_failed", { phase: "review_audit", messageId: existing.message_id });

  return {
    ok: true,
    mode: "save_review",
    classification_id: updated.id,
    message_id: updated.message_id,
    ...reviewSnapshot(updated as Record<string, any>),
    ...effectiveClassification(updated as Record<string, any>),
  };
}

async function adminClassificationView(supabase: ServiceClient, input: Input) {
  const [
    classificationsResult,
    replayResult,
    failedJobsResult,
    queuedCount,
    processingCount,
    succeededCount,
    failedCount,
    validCount,
    invalidCount,
    reviewCount,
    pendingReviewCount,
    replayGeneratedCount,
  ] = await Promise.all([
    supabase
      .from("email_message_classifications")
      .select("id, message_id, category, subcategory, confidence, priority, urgency, priority_level, urgency_level, response_timing, customer_risk, refund_risk, chargeback_risk, response_needed, summary, reasoning_summary, recommended_action, requires_human_review, safety_flags, validation_status, classification_run_id, input_version, created_at, classification_review_state, operator_override_category, operator_override_priority, operator_override_urgency, operator_notes, reviewed_by, reviewed_at")
      .eq("source", "ai")
      .order("created_at", { ascending: false })
      .limit(input.classificationLimit),
    supabase
      .from("email_operational_events")
      .select("id, reason, idempotency_key, new_job_ids, payload, created_at")
      .eq("event_type", "classification_replay")
      .order("created_at", { ascending: false })
      .limit(input.replayLimit),
    supabase
      .from("email_processing_jobs")
      .select("id, message_id, status, attempt_count, last_error_code, last_error_message, metadata, updated_at")
      .eq("job_type", "classify")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(input.failedJobLimit),
    countRows(supabase, "email_processing_jobs", (query) => query.eq("job_type", "classify").eq("status", "queued")),
    countRows(supabase, "email_processing_jobs", (query) => query.eq("job_type", "classify").eq("status", "running")),
    countRows(supabase, "email_processing_jobs", (query) => query.eq("job_type", "classify").eq("status", "succeeded")),
    countRows(supabase, "email_processing_jobs", (query) => query.eq("job_type", "classify").eq("status", "failed")),
    countRows(supabase, "email_message_classifications", (query) => query.eq("source", "ai").eq("validation_status", "valid")),
    countRows(supabase, "email_message_classifications", (query) => query.eq("source", "ai").eq("validation_status", "invalid")),
    countRows(supabase, "email_message_classifications", (query) => query.eq("source", "ai").eq("requires_human_review", true)),
    countRows(supabase, "email_message_classifications", (query) => query.eq("source", "ai").eq("requires_human_review", true).eq("classification_review_state", "pending_review")),
    countRows(supabase, "email_message_classifications", (query) => query.eq("source", "ai").like("input_version", "v1:classification_replay:%")),
  ]);

  if (classificationsResult.error) throw new ClassifierError("admin_view_classifications_failed", { phase: "admin_view_classifications" });
  if (replayResult.error) throw new ClassifierError("admin_view_replay_failed", { phase: "admin_view_replay" });
  if (failedJobsResult.error) throw new ClassifierError("admin_view_failed_jobs_failed", { phase: "admin_view_failed_jobs" });

  const messageIds = uniqueStrings(
    (classificationsResult.data || []).map((row: Record<string, any>) => row.message_id),
    input.classificationLimit,
  );
  const messageMetadataById = new Map<string, Record<string, any>>();
  if (messageIds.length) {
    const { data: messageRows, error: messageError } = await supabase
      .from("email_messages")
      .select("id, subject, from_name, from_email, sender_name, sender_email, received_at, body_preview")
      .in("id", messageIds);

    if (messageError) throw new ClassifierError("admin_view_message_metadata_failed", { phase: "admin_view_message_metadata" });
    for (const message of messageRows || []) {
      messageMetadataById.set(String(message.id), message as Record<string, any>);
    }
  }

  const replayOperations = (replayResult.data || []).map((event: Record<string, any>) => ({
    id: event.id,
    reason: event.reason,
    idempotency_key: event.idempotency_key,
    created_job_ids: Array.isArray(event.new_job_ids) ? event.new_job_ids : [],
    created_job_count: Array.isArray(event.new_job_ids) ? event.new_job_ids.length : 0,
    jobs_enqueued: Number(event.payload?.jobs_enqueued || 0),
    jobs_skipped_active: Number(event.payload?.jobs_skipped_active || 0),
    created_at: event.created_at,
  }));

  return {
    ok: true,
    mode: "admin_view",
    classifications: (classificationsResult.data || []).map((row: Record<string, any>) => {
      const message = messageMetadataById.get(String(row.message_id)) || {};
      return {
        id: row.id,
        message_id: row.message_id,
        message_subject: shortText(message.subject, 300) || null,
        message_sender_name: shortText(message.from_name || message.sender_name, 120) || null,
        message_sender_email: shortText(message.from_email || message.sender_email, 180).toLowerCase() || null,
        message_received_at: message.received_at || null,
        message_body_preview: shortText(message.body_preview, 800) || null,
        category: row.category,
        subcategory: row.subcategory,
        confidence: row.confidence === null ? null : Number(row.confidence),
        priority: row.priority,
        urgency: row.urgency,
        ...effectiveClassification(row),
        priority_level: row.priority_level,
        urgency_level: row.urgency_level,
        response_timing: row.response_timing,
        customer_risk: row.customer_risk,
        refund_risk: row.refund_risk === true,
        chargeback_risk: row.chargeback_risk === true,
        response_needed: row.response_needed,
        summary: row.summary,
        reasoning_summary: row.reasoning_summary,
        recommended_action: row.recommended_action,
        requires_human_review: row.requires_human_review,
        safety_flags: Array.isArray(row.safety_flags) ? row.safety_flags : [],
        validation_status: row.validation_status,
        classification_run_id: row.classification_run_id,
        input_version: row.input_version,
        created_at: row.created_at,
        classification_review_state: reviewStateForRow(row),
        operator_override_category: row.operator_override_category || null,
        operator_override_priority: row.operator_override_priority || null,
        operator_override_urgency: row.operator_override_urgency || null,
        operator_notes: row.operator_notes || null,
        reviewed_by: row.reviewed_by || null,
        reviewed_at: row.reviewed_at || null,
      };
    }),
    replay_operations: replayOperations,
    failed_jobs: (failedJobsResult.data || []).map((job: Record<string, any>) => ({
      id: job.id,
      message_id: job.message_id,
      status: job.status,
      attempt_count: job.attempt_count,
      last_error_code: job.last_error_code,
      last_error_message: shortText(job.last_error_message, 500),
      metadata: safeMetadata(job.metadata || {}),
      updated_at: job.updated_at,
    })),
    queue_summary: {
      queued: queuedCount,
      processing: processingCount,
      succeeded: succeededCount,
      failed: failedCount,
    },
    validation_diagnostics: {
      valid_classifications: validCount,
      invalid_classifications: invalidCount,
      requires_human_review: reviewCount,
      pending_human_review: pendingReviewCount,
      replay_generated_classifications: replayGeneratedCount,
    },
  };
}

async function adminMessageDetail(supabase: ServiceClient, input: Input) {
  if (!input.messageId) throw new ClassifierError("message_id_required", { status: 400, phase: "input" });

  const [
    messageResult,
    bodyResult,
    classificationResult,
  ] = await Promise.all([
    supabase
      .from("email_messages")
      .select("id, subject, from_name, from_email, sender_name, sender_email, received_at, sent_at, body_preview, body_content_type, has_attachments, sync_status")
      .eq("id", input.messageId)
      .maybeSingle(),
    supabase
      .from("email_message_bodies")
      .select("body_text, normalized_text, normalization_version, redaction_status")
      .eq("message_id", input.messageId)
      .maybeSingle(),
    supabase
      .from("email_message_classifications")
      .select("id, category, subcategory, confidence, priority, urgency, priority_level, urgency_level, response_timing, customer_risk, refund_risk, chargeback_risk, response_needed, summary, reasoning_summary, recommended_action, requires_human_review, safety_flags, validation_status, created_at, classification_review_state, operator_override_category, operator_override_priority, operator_override_urgency, operator_notes, reviewed_by, reviewed_at")
      .eq("message_id", input.messageId)
      .eq("source", "ai")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (messageResult.error) throw new ClassifierError("message_lookup_failed", { phase: "message_detail_lookup", messageId: input.messageId });
  if (!messageResult.data?.id) throw new ClassifierError("message_not_found", { status: 404, phase: "message_detail_lookup", messageId: input.messageId });
  if (messageResult.data.sync_status !== "active") {
    throw new ClassifierError("message_not_active", { status: 400, phase: "message_detail_lookup", messageId: input.messageId });
  }
  if (bodyResult.error) throw new ClassifierError("body_lookup_failed", { phase: "message_detail_body", messageId: input.messageId });
  if (classificationResult.error) {
    throw new ClassifierError("classification_lookup_failed", { phase: "message_detail_classification", messageId: input.messageId });
  }

  const message = messageResult.data as Record<string, any>;
  const body = bodyResult.data as Record<string, any> | null;
  const sourceText = body?.normalized_text || body?.body_text || message.body_preview || "";
  const bodySource = body?.normalized_text ? "normalized_text" : body?.body_text ? "body_text" : message.body_preview ? "body_preview" : "none";
  const cappedBody = capMessageDetailBody(sourceText);
  const classification = Array.isArray(classificationResult.data) ? classificationResult.data[0] : null;

  return {
    ok: true,
    mode: "message_detail",
    message_id: message.id,
    subject: shortText(message.subject, 300) || null,
    from_name: shortText(message.from_name, 120) || null,
    from_email: shortText(message.from_email, 180).toLowerCase() || null,
    sender_name: shortText(message.sender_name, 120) || null,
    sender_email: shortText(message.sender_email, 180).toLowerCase() || null,
    received_at: message.received_at || null,
    sent_at: message.sent_at || null,
    body_preview: shortText(message.body_preview, 800) || null,
    body_content_type: shortText(message.body_content_type, 80) || null,
    body_source: bodySource,
    normalized_text: cappedBody.text,
    body_truncated: cappedBody.body_truncated,
    body_chars_original: cappedBody.body_chars_original,
    body_chars_returned: cappedBody.body_chars_returned,
    normalization_version: shortText(body?.normalization_version, 120) || null,
    redaction_status: shortText(body?.redaction_status, 120) || null,
    has_attachments: message.has_attachments === true,
    classification: classification ? {
      id: classification.id,
      category: classification.category,
      subcategory: classification.subcategory,
      confidence: classification.confidence === null ? null : Number(classification.confidence),
      priority: classification.priority,
      urgency: classification.urgency,
      ...effectiveClassification(classification),
      priority_level: classification.priority_level,
      urgency_level: classification.urgency_level,
      response_timing: classification.response_timing,
      customer_risk: classification.customer_risk,
      refund_risk: classification.refund_risk === true,
      chargeback_risk: classification.chargeback_risk === true,
      response_needed: classification.response_needed,
      summary: classification.summary,
      reasoning_summary: classification.reasoning_summary,
      recommended_action: classification.recommended_action,
      requires_human_review: classification.requires_human_review,
      safety_flags: Array.isArray(classification.safety_flags) ? classification.safety_flags : [],
      validation_status: classification.validation_status,
      created_at: classification.created_at,
      classification_review_state: reviewStateForRow(classification),
      operator_override_category: classification.operator_override_category || null,
      operator_override_priority: classification.operator_override_priority || null,
      operator_override_urgency: classification.operator_override_urgency || null,
      operator_notes: classification.operator_notes || null,
      reviewed_by: classification.reviewed_by || null,
      reviewed_at: classification.reviewed_at || null,
    } : null,
  };
}

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function compactTask(row: Record<string, any>, source: "order_task" | "return_task") {
  return {
    source,
    id: row.id,
    task_type: row.task_type,
    title: shortText(row.title, 180) || null,
    status: row.status,
    priority: row.priority,
    due_at: row.due_at || null,
    started_at: row.started_at || null,
    resolved_at: row.resolved_at || null,
    created_at: row.created_at || null,
  };
}

function safeLabelMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    ["trackingNumber", "shippingBarcodeNumber", "labelId"]
      .map((key) => [key, shortText(source[key], 160) || null])
      .filter(([, item]) => Boolean(item)),
  );
}

function taskOperationalSummary(task: Record<string, unknown>) {
  const source = String(task.source || "");
  const status = String(task.status || "").replace(/_/g, " ").trim();
  const taskType = String(task.task_type || "").replace(/_/g, " ").trim();
  const isReturn = source === "return_task";
  const state = status || "pending";
  if (isReturn) {
    return {
      source: "return_task",
      status: task.status || null,
      operational_state: taskType ? `return ${taskType} is ${state}` : `return intake is ${state}`,
      due_at: task.due_at || null,
      resolved_at: task.resolved_at || null,
    };
  }
  return {
    source: "order_task",
    status: task.status || null,
    operational_state: taskType ? `order ${taskType} is ${state}` : `internal review is ${state}`,
    due_at: task.due_at || null,
    resolved_at: task.resolved_at || null,
  };
}

function buildVerifiedOrderContext(adminContext: Record<string, any>) {
  const known = adminContext.known && typeof adminContext.known === "object" ? adminContext.known : {};
  const orders = Array.isArray(known.order) ? known.order : [];
  const lines = Array.isArray(known.order_lines) ? known.order_lines : [];
  const shippingRows = Array.isArray(known.shipping) ? known.shipping : [];
  const returnCases = Array.isArray(known.return_case) ? known.return_case : [];
  const tasks = Array.isArray(known.tasks) ? known.tasks : [];

  const safeOrders = orders.map((order: Record<string, any>) => ({
    order_number: order.order_number || null,
    sale_date: order.sale_date || null,
    paid_on_date: order.paid_on_date || null,
    ship_by_date: order.ship_by_date || null,
    shipped_on_date: order.shipped_on_date || null,
    status: order.status || null,
  }));
  const safeLines = lines.map((line: Record<string, any>) => ({
    item_number: line.item_number || null,
    transaction_id: line.transaction_id || null,
    item_title: shortText(line.item_title, 240) || null,
    quantity: line.quantity ?? null,
    line_status: line.line_status || null,
  }));
  const safeShipping = shippingRows.map((shipping: Record<string, any>) => ({
    order_number: shipping.order_number || null,
    tracking_number: shipping.tracking_number || null,
    shipping_service: shipping.shipping_service || null,
    safe_label_metadata: safeLabelMetadata(shipping.safe_label_metadata),
  }));
  const safeReturns = returnCases.map((returnCase: Record<string, any>) => ({
    ebay_return_id: returnCase.ebay_return_id || null,
    return_reason: shortText(returnCase.return_reason, 240) || null,
    status: returnCase.status || null,
    opened_at: returnCase.opened_at || null,
    received_at: returnCase.received_at || null,
    closed_at: returnCase.closed_at || null,
  }));
  const safeTasks = tasks.map(taskOperationalSummary).slice(0, 10);

  const shippingContextExisted = safeShipping.some((row) =>
    Boolean(row.tracking_number || row.shipping_service || Object.keys(row.safe_label_metadata || {}).length)
  );
  const injectedCategories = [
    safeOrders.length ? "order" : "",
    safeLines.length ? "order_lines" : "",
    shippingContextExisted ? "shipping" : "",
    safeReturns.length ? "return" : "",
    safeTasks.length ? "tasks" : "",
  ].filter(Boolean);

  const unknown = new Set<string>(Array.isArray(adminContext.unknown) ? adminContext.unknown : []);
  if (!safeOrders.length) unknown.add("verified order context not found");
  if (!safeLines.length) unknown.add("verified order line context not found");
  if (!shippingContextExisted) unknown.add("verified tracking/shipping context not found");
  if (!safeReturns.length) unknown.add("verified return case context not found");

  return {
    context_version: VERIFIED_ORDER_CONTEXT_VERSION,
    known: {
      order: safeOrders,
      order_lines: safeLines,
      shipping: safeShipping,
      return_case: safeReturns,
      tasks: safeTasks,
    },
    unknown: [...unknown].slice(0, 40),
    do_not_claim: [
      "do not claim order status, shipment status, refund status, return approval, replacement availability, tracking, or timeline unless present in known facts",
      "do not expose internal notes, employee names, admin comments, GPS/evidence data, raw payloads, costs, fees, taxes, or payout information",
      "do not infer item type beyond verified order line item_title",
      "do not describe label metadata except the safe trackingNumber, shippingBarcodeNumber, or labelId keys",
    ],
    summary: {
      verified_context_used: true,
      injected_categories: injectedCategories,
      order_context_existed: safeOrders.length > 0,
      return_context_existed: safeReturns.length > 0,
      shipping_context_existed: shippingContextExisted,
      order_line_context_existed: safeLines.length > 0,
      task_context_existed: safeTasks.length > 0,
    },
  };
}

function safePriorReturnMessage(row: Record<string, any>) {
  return {
    id: row.id,
    return_case_id: row.return_case_id || null,
    order_id: row.order_id || null,
    order_number: row.order_number || null,
    ebay_return_id: row.ebay_return_id || null,
    buyer_username: row.buyer_username || null,
    direction: row.direction,
    channel: row.channel,
    message_status: row.message_status,
    item_title: shortText(row.item_title, 180) || null,
    return_reason: shortText(row.return_reason, 180) || null,
    sent_at: row.sent_at || null,
    logged_at: row.logged_at || null,
    safe_summary: shortText(row.message_body, 300) || null,
  };
}

function linkEvidence(link: Record<string, any>) {
  const evidence = new Set<string>();
  const method = String(link.match_method || link.metadata?.matched_by || "");
  if (method) evidence.add(`${method.replace(/_/g, " ")} match`);
  if (link.matched_value) evidence.add(`matched value: ${shortText(link.matched_value, 80)}`);
  if (link.ebay_order_id) evidence.add("linked eBay order id present");
  if (link.ebay_order_line_id) evidence.add("linked eBay order line id present");
  if (link.item_id) evidence.add("linked inventory item id present");
  if (link.sale_id) evidence.add("linked sale id present");
  const identifiers = link.metadata?.extracted_identifiers;
  if (identifiers && typeof identifiers === "object") {
    for (const [key, value] of Object.entries(identifiers).slice(0, 8)) {
      const count = Array.isArray(value) ? value.length : value ? 1 : 0;
      if (count > 0) evidence.add(`${key.replace(/_/g, " ")} extracted`);
    }
  }
  if (link.metadata?.guarded_by_context) evidence.add("guarded by stronger context clue");
  if (link.metadata?.buyer_username_only) evidence.add("buyer username only; review recommended");
  if (link.metadata?.masked_email_excluded) evidence.add("masked email excluded");
  if (link.metadata?.unique_order) evidence.add("unique order candidate");
  return [...evidence].slice(0, 8);
}

async function adminContextView(supabase: ServiceClient, input: Input) {
  if (!input.messageId) throw new ClassifierError("message_id_required", { status: 400, phase: "admin_context_view" });

  const { data: message, error: messageError } = await supabase
    .from("email_messages")
    .select("id, subject, from_email, from_name, sender_email, sender_name, received_at, sync_status")
    .eq("id", input.messageId)
    .maybeSingle();
  if (messageError) throw new ClassifierError("message_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });
  if (!message?.id) throw new ClassifierError("message_not_found", { status: 404, phase: "admin_context_view", messageId: input.messageId });

  let linksQuery = supabase
    .from("email_message_links")
    .select("id, link_type, matched_value, match_method, confidence, status, ebay_order_id, ebay_order_line_id, item_id, sale_id, metadata, created_at")
    .eq("message_id", input.messageId);
  if (input.mode !== "operator_match_context") {
    linksQuery = linksQuery.in("status", ["suggested", "confirmed"]);
  }
  const { data: links, error: linksError } = await linksQuery
    .order("confidence", { ascending: false, nullsFirst: false })
    .limit(50);
  if (linksError) throw new ClassifierError("link_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });

  const activeLinks = (links || []) as Array<Record<string, any>>;
  const orderIds = uniqueIds(activeLinks.map((link) => link.ebay_order_id));
  const orderLineIds = uniqueIds(activeLinks.map((link) => link.ebay_order_line_id));
  const itemIds = uniqueIds(activeLinks.map((link) => link.item_id));
  const returnCaseIdsFromMetadata = uniqueIds(activeLinks.map((link) => link.metadata?.return_case_id));

  const [ordersResult, linesResult] = await Promise.all([
    orderIds.length
      ? supabase
        .from("ebay_orders")
        .select("id, order_number, sales_record_number, buyer_username, sale_date, paid_on_date, ship_by_date, shipped_on_date, status, tracking_number, shipping_service, label_status, label_metadata")
        .in("id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    orderLineIds.length
      ? supabase
        .from("ebay_order_lines")
        .select("id, order_id, item_number, transaction_id, item_title, custom_label, quantity, fulfilled_quantity, line_status, internal_item_id, sale_id")
        .in("id", orderLineIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (ordersResult.error) throw new ClassifierError("order_context_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });
  if (linesResult.error) throw new ClassifierError("order_line_context_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });

  const linkedLines = (linesResult.data || []) as Array<Record<string, any>>;
  const lineOrderIds = uniqueIds(linkedLines.map((line) => line.order_id));
  const allOrderIds = uniqueIds([...orderIds, ...lineOrderIds]);

  const [lineOrdersResult, orderLinesForOrdersResult, returnCasesByOrderResult, returnCasesByIdResult, orderTasksResult] = await Promise.all([
    lineOrderIds.filter((id) => !orderIds.includes(id)).length
      ? supabase
        .from("ebay_orders")
        .select("id, order_number, sales_record_number, buyer_username, sale_date, paid_on_date, ship_by_date, shipped_on_date, status, tracking_number, shipping_service, label_status, label_metadata")
        .in("id", lineOrderIds.filter((id) => !orderIds.includes(id)))
      : Promise.resolve({ data: [], error: null }),
    allOrderIds.length
      ? supabase
        .from("ebay_order_lines")
        .select("id, order_id, item_number, transaction_id, item_title, custom_label, quantity, fulfilled_quantity, line_status, internal_item_id, sale_id")
        .in("order_id", allOrderIds)
        .limit(50)
      : Promise.resolve({ data: [], error: null }),
    allOrderIds.length
      ? supabase
        .from("ebay_return_cases")
        .select("id, order_id, order_number, case_type, ebay_return_id, buyer_username, return_reason, return_tracking_number, status, opened_at, received_at, closed_at")
        .in("order_id", allOrderIds)
      : Promise.resolve({ data: [], error: null }),
    returnCaseIdsFromMetadata.length
      ? supabase
        .from("ebay_return_cases")
        .select("id, order_id, order_number, case_type, ebay_return_id, buyer_username, return_reason, return_tracking_number, status, opened_at, received_at, closed_at")
        .in("id", returnCaseIdsFromMetadata)
      : Promise.resolve({ data: [], error: null }),
    allOrderIds.length
      ? supabase
        .from("ebay_order_tasks")
        .select("id, order_id, order_line_ids, task_type, title, status, priority, due_at, started_at, resolved_at, created_at")
        .in("order_id", allOrderIds)
        .order("created_at", { ascending: false })
        .limit(20)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [lineOrdersResult, orderLinesForOrdersResult, returnCasesByOrderResult, returnCasesByIdResult, orderTasksResult]) {
    if (result.error) throw new ClassifierError("business_context_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });
  }

  const orders = [...((ordersResult.data || []) as Array<Record<string, any>>), ...((lineOrdersResult.data || []) as Array<Record<string, any>>)];
  const lineById = new Map<string, Record<string, any>>();
  for (const line of [...linkedLines, ...((orderLinesForOrdersResult.data || []) as Array<Record<string, any>>)]) {
    lineById.set(String(line.id), line);
  }
  const lines = [...lineById.values()];
  const internalItemIds = uniqueIds([...itemIds, ...lines.map((line) => line.internal_item_id)]);
  const internalItemsResult = internalItemIds.length
    ? await supabase
      .from("item_types")
      .select("id, title, barcode, qr_code, categories")
      .in("id", internalItemIds)
    : { data: [], error: null };
  if (internalItemsResult.error) throw new ClassifierError("item_context_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });

  const returnCaseById = new Map<string, Record<string, any>>();
  for (const row of [...((returnCasesByOrderResult.data || []) as Array<Record<string, any>>), ...((returnCasesByIdResult.data || []) as Array<Record<string, any>>)]) {
    returnCaseById.set(String(row.id), row);
  }
  const returnCases = [...returnCaseById.values()];
  const returnCaseIds = uniqueIds(returnCases.map((row) => row.id));

  const [returnItemsResult, returnTasksResult, returnMessagesResult] = await Promise.all([
    returnCaseIds.length
      ? supabase
        .from("ebay_return_items")
        .select("id, return_case_id, order_id, order_line_id, internal_item_id, item_title, item_number, expected_quantity, received_quantity, condition_received, disposition, processed_at")
        .in("return_case_id", returnCaseIds)
      : Promise.resolve({ data: [], error: null }),
    returnCaseIds.length
      ? supabase
        .from("ebay_return_tasks")
        .select("id, return_case_id, order_id, order_line_ids, task_type, title, status, priority, due_at, started_at, resolved_at, created_at")
        .in("return_case_id", returnCaseIds)
        .order("created_at", { ascending: false })
        .limit(20)
      : Promise.resolve({ data: [], error: null }),
    returnCaseIds.length || allOrderIds.length
      ? supabase
        .from("ebay_return_messages")
        .select("id, return_case_id, order_id, order_number, ebay_return_id, buyer_username, direction, channel, message_status, message_body, item_title, return_reason, sent_at, logged_at")
        .or([
          returnCaseIds.length ? `return_case_id.in.(${returnCaseIds.join(",")})` : "",
          allOrderIds.length ? `order_id.in.(${allOrderIds.join(",")})` : "",
        ].filter(Boolean).join(","))
        .order("logged_at", { ascending: false })
        .limit(10)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [returnItemsResult, returnTasksResult, returnMessagesResult]) {
    if (result.error) throw new ClassifierError("return_context_lookup_failed", { phase: "admin_context_view", messageId: input.messageId });
  }

  const itemById = new Map<string, Record<string, any>>();
  for (const row of internalItemsResult.data || []) itemById.set(String(row.id), row as Record<string, any>);

  const unknown: string[] = [];
  if (!activeLinks.length) unknown.push("deterministic link not found");
  if (!orders.some((order) => order.tracking_number || Object.keys(safeLabelMetadata(order.label_metadata)).length)) unknown.push("tracking number not found");
  if (!returnCases.length) unknown.push("return case not found");
  if (!lines.length) unknown.push("order line link not found");
  if (lines.some((line) => !line.internal_item_id) || (!lines.length && !itemIds.length)) unknown.push("internal item link not found");

  const hasMaskedEmail = [message.from_email, message.sender_email]
    .map((value) => String(value || "").toLowerCase())
    .some((value) => value.includes("ebay") || value.includes("noreply") || value.includes("no-reply"));
  if (hasMaskedEmail) unknown.push("buyer email masked/unreliable");

  return {
    ok: true,
    mode: input.mode === "operator_match_context" ? "operator_match_context" : "admin_context_view",
    message_id: message.id,
    context_version: "readonly-ebay-context-v1",
    draft_enrichment: {
      verified_order_context_supported: true,
      safe_context_version: VERIFIED_ORDER_CONTEXT_VERSION,
      order_context_existed: orders.length > 0,
      return_context_existed: returnCases.length > 0,
      shipping_context_existed: orders.some((order) =>
        Boolean(order.tracking_number || order.shipping_service || Object.keys(safeLabelMetadata(order.label_metadata)).length)
      ),
      safe_label_metadata_keys: ["trackingNumber", "shippingBarcodeNumber", "labelId"],
    },
    known: {
      order: orders.map((order) => ({
        id: order.id,
        order_number: order.order_number,
        sales_record_number: order.sales_record_number || null,
        buyer_username: order.buyer_username || null,
        sale_date: order.sale_date || null,
        paid_on_date: order.paid_on_date || null,
        ship_by_date: order.ship_by_date || null,
        shipped_on_date: order.shipped_on_date || null,
        status: order.status || null,
      })),
      order_lines: lines.map((line) => ({
        id: line.id,
        order_id: line.order_id,
        item_number: line.item_number || null,
        transaction_id: line.transaction_id || null,
        item_title: shortText(line.item_title, 240) || null,
        custom_label: line.custom_label || null,
        quantity: line.quantity,
        fulfilled_quantity: line.fulfilled_quantity,
        line_status: line.line_status || null,
        internal_item: line.internal_item_id && itemById.has(String(line.internal_item_id))
          ? {
            id: line.internal_item_id,
            title: shortText(itemById.get(String(line.internal_item_id))?.title, 200) || null,
            barcode: itemById.get(String(line.internal_item_id))?.barcode || null,
            qr_code: itemById.get(String(line.internal_item_id))?.qr_code || null,
          }
          : null,
      })),
      return_case: returnCases.map((returnCase) => ({
        id: returnCase.id,
        order_id: returnCase.order_id || null,
        order_number: returnCase.order_number || null,
        case_type: returnCase.case_type || null,
        ebay_return_id: returnCase.ebay_return_id || null,
        buyer_username: returnCase.buyer_username || null,
        return_reason: shortText(returnCase.return_reason, 240) || null,
        return_tracking_number: returnCase.return_tracking_number || null,
        status: returnCase.status || null,
        opened_at: returnCase.opened_at || null,
        received_at: returnCase.received_at || null,
        closed_at: returnCase.closed_at || null,
      })),
      return_items: ((returnItemsResult.data || []) as Array<Record<string, any>>).map((item) => ({
        id: item.id,
        return_case_id: item.return_case_id,
        order_id: item.order_id,
        order_line_id: item.order_line_id,
        internal_item_id: item.internal_item_id || null,
        item_title: shortText(item.item_title, 240) || null,
        item_number: item.item_number || null,
        expected_quantity: item.expected_quantity,
        received_quantity: item.received_quantity,
        condition_received: item.condition_received,
        disposition: item.disposition,
        processed_at: item.processed_at || null,
      })),
      shipping: orders.map((order) => ({
        order_id: order.id,
        order_number: order.order_number,
        tracking_number: order.tracking_number || null,
        shipping_service: order.shipping_service || null,
        safe_label_metadata: safeLabelMetadata(order.label_metadata),
        label_status: order.label_status || null,
        shipped_on_date: order.shipped_on_date || null,
        ship_by_date: order.ship_by_date || null,
      })),
      tasks: [
        ...((orderTasksResult.data || []) as Array<Record<string, any>>).map((task) => compactTask(task, "order_task")),
        ...((returnTasksResult.data || []) as Array<Record<string, any>>).map((task) => compactTask(task, "return_task")),
      ],
      prior_messages: ((returnMessagesResult.data || []) as Array<Record<string, any>>).map(safePriorReturnMessage),
    },
    unknown: [...new Set(unknown)],
    do_not_claim: [
      "do not claim refund has been approved unless verified in returned DB state",
      "do not claim item type if only generic text matched",
      "do not claim delivery date unless tracking or delivery data exists",
      "do not claim replacement availability unless inventory context proves it",
      "do not quote internal task notes to buyer",
      "do not expose costs, net payout, fees, taxes, employee emails, raw payloads, evidence paths, or private staff comments",
    ],
    match_summary: activeLinks.map((link) => ({
      id: link.id,
      link_type: link.link_type,
      status: link.status,
      confidence: Number(link.confidence || 0),
      match_method: link.match_method,
      matched_value: shortText(link.matched_value, 160) || null,
      ebay_order_id: link.ebay_order_id || null,
      ebay_order_line_id: link.ebay_order_line_id || null,
      item_id: link.item_id || null,
      sale_id: link.sale_id || null,
      has_ebay_order: Boolean(link.ebay_order_id),
      has_ebay_order_line: Boolean(link.ebay_order_line_id),
      has_inventory_item: Boolean(link.item_id),
      has_sale: Boolean(link.sale_id),
      evidence: linkEvidence(link),
      metadata_return_case_id: link.metadata?.return_case_id || null,
      created_at: link.created_at || null,
    })),
  };
}

function firstById(rows: Array<Record<string, any>>, id: string | null | undefined) {
  if (!id) return null;
  return rows.find((row) => String(row.id) === String(id)) || null;
}

function firstByOrderId(rows: Array<Record<string, any>>, orderId: string | null | undefined) {
  if (!orderId) return null;
  return rows.find((row) => String(row.order_id || "") === String(orderId)) || null;
}

function orderFacts(order: Record<string, any> | null) {
  if (!order) return null;
  return {
    order_number: order.order_number || null,
    status: order.status || null,
    sale_date: order.sale_date || null,
    buyer_username: order.buyer_username || null,
    tracking_number: null,
  };
}

function returnFacts(returnCase: Record<string, any> | null) {
  if (!returnCase) return null;
  return {
    id: returnCase.id || null,
    ebay_return_id: returnCase.ebay_return_id || null,
    status: returnCase.status || null,
    return_reason: returnCase.return_reason || null,
    return_tracking_number: returnCase.return_tracking_number || null,
    opened_at: returnCase.opened_at || null,
  };
}

function shippingFacts(shipping: Record<string, any> | null) {
  if (!shipping) return { tracking_number: null, shipping_service: null };
  return {
    tracking_number: shipping.tracking_number || shipping.safe_label_metadata?.trackingNumber || null,
    shipping_service: shipping.shipping_service || null,
    label_status: shipping.label_status || null,
    shipped_on_date: shipping.shipped_on_date || null,
  };
}

function itemTitleForMatch(line: Record<string, any> | null, returnCase: Record<string, any> | null, context: Record<string, any>) {
  if (line?.item_title) return shortText(line.item_title, 180);
  const returnItem = (context.known?.return_items || []).find((item: Record<string, any>) =>
    (line?.id && item.order_line_id === line.id) ||
    (returnCase?.id && item.return_case_id === returnCase.id)
  );
  return returnItem?.item_title ? shortText(returnItem.item_title, 180) : null;
}

async function latestValidationForMessage(supabase: ServiceClient, messageId: string) {
  const { data: draftRows, error: draftError } = await supabase
    .from("email_response_drafts")
    .select("id, validation_status, validation_errors, safety_flags, requires_human_review, draft_status, created_at")
    .eq("message_id", messageId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1);
  if (draftError) throw new ClassifierError("response_draft_lookup_failed", { phase: "operator_match_context", messageId });

  const draft = Array.isArray(draftRows) ? draftRows[0] as Record<string, any> | undefined : undefined;
  if (draft?.id) {
    return {
      validation_status: draft.validation_status || "not_validated",
      validation_errors: Array.isArray(draft.validation_errors) ? draft.validation_errors : [],
      safety_flags: safeArray(draft.safety_flags),
      requires_human_review: draft.requires_human_review !== false,
      source: "current_response_draft",
      draft_id: draft.id,
      draft_status: draft.draft_status || null,
    };
  }

  const { data: classificationRows, error: classificationError } = await supabase
    .from("email_message_classifications")
    .select("id, validation_status, validation_errors, safety_flags, requires_human_review, created_at")
    .eq("message_id", messageId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1);
  if (classificationError) throw new ClassifierError("classification_lookup_failed", { phase: "operator_match_context", messageId });

  const classification = Array.isArray(classificationRows) ? classificationRows[0] as Record<string, any> | undefined : undefined;
  return {
    validation_status: classification?.validation_status || "not_validated",
    validation_errors: Array.isArray(classification?.validation_errors) ? classification.validation_errors : [],
    safety_flags: safeArray(classification?.safety_flags),
    requires_human_review: classification?.requires_human_review !== false,
    source: classification?.id ? "current_classification" : "none",
    classification_id: classification?.id || null,
  };
}

async function operatorMatchContext(supabase: ServiceClient, input: Input) {
  if (!input.messageId) throw new ClassifierError("message_id_required", { status: 400, phase: "operator_match_context" });
  const context = await adminContextView(supabase, { ...input, mode: "operator_match_context" });
  const orders = context.known?.order || [];
  const lines = context.known?.order_lines || [];
  const returns = context.known?.return_case || [];
  const shippingRows = context.known?.shipping || [];

  const matches = (context.match_summary || []).map((link: Record<string, any>) => {
    const line = firstById(lines, link.ebay_order_line_id);
    const orderId = link.ebay_order_id || line?.order_id || null;
    const order = firstById(orders, orderId);
    const returnCase = firstById(returns, link.metadata_return_case_id) || firstByOrderId(returns, orderId);
    const shipping = firstByOrderId(shippingRows, orderId);
    return {
      link_id: link.id,
      link_type: link.link_type,
      status: link.status,
      confidence: link.confidence,
      match_method: link.match_method,
      matched_value: link.matched_value,
      evidence: Array.isArray(link.evidence) ? link.evidence : [],
      order: orderFacts(order),
      return_case: returnFacts(returnCase),
      shipping: shippingFacts(shipping),
      item_title: itemTitleForMatch(line, returnCase, context),
      verified_context: {
        has_order: Boolean(order),
        has_return_case: Boolean(returnCase),
        has_shipping: Boolean(shipping?.tracking_number || shipping?.shipping_service || shipping?.label_status),
        has_order_line: Boolean(line),
      },
    };
  });

  return {
    ok: true,
    mode: "operator_match_context",
    message_id: context.message_id,
    matches,
    validation: await latestValidationForMessage(supabase, String(context.message_id)),
    unknown: Array.isArray(context.unknown) ? context.unknown : [],
    do_not_claim: Array.isArray(context.do_not_claim) ? context.do_not_claim : [],
    verified_context: {
      context_version: context.context_version || null,
      indicators: context.draft_enrichment || {},
    },
  };
}

async function updateMatchReviewStatus(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string; email: string | null },
  status: "confirmed" | "rejected" | "stale",
) {
  if (!input.linkId) throw new ClassifierError("link_id_required", { status: 400, phase: "match_review" });
  const { data: link, error: lookupError } = await supabase
    .from("email_message_links")
    .select("id, message_id, link_type, status, confidence, match_method, matched_value, metadata")
    .eq("id", input.linkId)
    .maybeSingle();
  if (lookupError) throw new ClassifierError("link_lookup_failed", { phase: "match_review" });
  if (!link?.id) throw new ClassifierError("link_not_found", { status: 404, phase: "match_review" });

  const priorMetadata = link.metadata && typeof link.metadata === "object" ? link.metadata : {};
  const history = Array.isArray(priorMetadata.operator_review_history) ? priorMetadata.operator_review_history : [];
  const nowIso = new Date().toISOString();
  const metadata = {
    ...priorMetadata,
    operator_review_history: [
      ...history.slice(-19),
      {
        from_status: link.status || null,
        to_status: status,
        reviewed_by: admin.userId,
        reviewed_at: nowIso,
        reason: status === "rejected" ? input.reason : null,
      },
    ],
    last_operator_review: {
      from_status: link.status || null,
      to_status: status,
      reviewed_by: admin.userId,
      reviewed_at: nowIso,
      reason: status === "rejected" ? input.reason : null,
    },
  };

  const { data, error } = await supabase
    .from("email_message_links")
    .update({ status, metadata })
    .eq("id", input.linkId)
    .select("id, message_id, link_type, status, confidence, match_method, matched_value, metadata")
    .single();
  if (error || !data?.id) throw new ClassifierError("link_review_update_failed", { phase: "match_review" });

  return {
    ok: true,
    mode: input.mode,
    link_id: data.id,
    message_id: data.message_id,
    link_type: data.link_type,
    status: data.status,
    confidence: Number(data.confidence || 0),
    match_method: data.match_method,
    matched_value: data.matched_value || null,
    reviewed_by: admin.userId,
    reviewed_at: nowIso,
    outlook_mutation_performed: false,
    ebay_mutation_performed: false,
    outbound_send_enabled: false,
  };
}

async function loadResponseDraftInput(
  supabase: ServiceClient,
  input: Input,
  promptVersionValue: string,
): Promise<ResponseDraftInput> {
  let messageId = input.messageId;
  let classificationId = input.classificationId;

  if (input.draftId) {
    const { data: draft, error: draftError } = await supabase
      .from("email_response_drafts")
      .select("id, message_id, classification_id")
      .eq("id", input.draftId)
      .maybeSingle();
    if (draftError) throw new ClassifierError("response_draft_lookup_failed", { phase: "response_draft_input" });
    if (!draft?.id) throw new ClassifierError("response_draft_not_found", { status: 404, phase: "response_draft_input" });
    if (messageId && draft.message_id !== messageId) {
      throw new ClassifierError("response_draft_message_mismatch", { status: 400, phase: "response_draft_input" });
    }
    if (classificationId && draft.classification_id && draft.classification_id !== classificationId) {
      throw new ClassifierError("response_draft_classification_mismatch", { status: 400, phase: "response_draft_input" });
    }
    messageId = String(draft.message_id);
    classificationId = draft.classification_id ? String(draft.classification_id) : classificationId;
  }

  let classificationQuery = supabase
    .from("email_message_classifications")
    .select("id, message_id, category, subcategory, priority, urgency, priority_level, urgency_level, response_timing, customer_risk, refund_risk, chargeback_risk, response_needed, summary, reasoning_summary, recommended_action, requires_human_review, safety_flags, validation_status, classification_review_state, operator_override_category, operator_override_priority, operator_override_urgency, operator_notes, reviewed_by, reviewed_at")
    .eq("source", "ai")
    .eq("validation_status", "valid")
    .order("created_at", { ascending: false })
    .limit(1);

  if (classificationId) {
    classificationQuery = classificationQuery.eq("id", classificationId);
  } else if (messageId) {
    classificationQuery = classificationQuery.eq("message_id", messageId).eq("is_current", true);
  }

  const { data: classificationRows, error: classificationError } = await classificationQuery;
  if (classificationError) throw new ClassifierError("response_draft_classification_lookup_failed", { phase: "response_draft_input" });
  const classification = Array.isArray(classificationRows) ? classificationRows[0] as Record<string, any> | undefined : undefined;
  if (!classification?.id) {
    throw new ClassifierError("valid_classification_required", { status: 400, phase: "response_draft_input" });
  }
  if (messageId && classification.message_id !== messageId) {
    throw new ClassifierError("classification_message_mismatch", { status: 400, phase: "response_draft_input" });
  }

  const classifierInput = await loadClassifierInput(supabase, String(classification.message_id), promptVersionValue);
  const effective = effectiveClassification(classification);
  const classificationState = {
    id: String(classification.id),
    category: String(classification.category || ""),
    subcategory: classification.subcategory || null,
    priority: classification.priority || null,
    urgency: classification.urgency || null,
    priority_level: classification.priority_level || null,
    urgency_level: classification.urgency_level || null,
    response_timing: classification.response_timing || null,
    customer_risk: classification.customer_risk || null,
    refund_risk: classification.refund_risk === true,
    chargeback_risk: classification.chargeback_risk === true,
    response_needed: classification.response_needed === null ? null : classification.response_needed === true,
    recommended_action: classification.recommended_action || null,
    requires_human_review: classification.requires_human_review !== false,
    safety_flags: safeArray(classification.safety_flags),
    summary: classification.summary || null,
    reasoning_summary: classification.reasoning_summary || null,
    validation_status: classification.validation_status || null,
    classification_review_state: reviewStateForRow(classification),
    operator_notes: classification.operator_notes || null,
    effective_category: String(effective.effective_category || classification.category || ""),
    effective_priority: effective.effective_priority || null,
    effective_urgency: effective.effective_urgency || null,
    has_operator_override: effective.has_operator_override,
  };

  if (!CATEGORIES.includes(classificationState.effective_category as typeof CATEGORIES[number])) {
    throw new ClassifierError("invalid_effective_category", { status: 400, phase: "response_draft_input" });
  }

  const verifiedOrderContext = buildVerifiedOrderContext(
    await adminContextView(supabase, {
      ...input,
      mode: "admin_context_view",
      messageId: String(classification.message_id),
    }),
  );

  return {
    message: classifierInput.message,
    participants: classifierInput.participants,
    deterministic_links: classifierInput.deterministic_links,
    body: classifierInput.body,
    classification: classificationState,
    draft_context: {
      generator_name: RESPONSE_DRAFT_GENERATOR_NAME,
      generator_version: RESPONSE_DRAFT_GENERATOR_VERSION,
      prompt_version: promptVersionValue,
      taxonomy_version: TAXONOMY_VERSION,
      link_context_version: LINK_CONTEXT_VERSION,
      verified_order_context_version: VERIFIED_ORDER_CONTEXT_VERSION,
      safety_policy_version: "response-draft-safety-v1",
    },
    verified_order_context: verifiedOrderContext,
  };
}

async function nextDraftVersion(supabase: ServiceClient, messageId: string) {
  const { data, error } = await supabase
    .from("email_response_drafts")
    .select("draft_version")
    .eq("message_id", messageId)
    .order("draft_version", { ascending: false })
    .limit(1);
  if (error) throw new ClassifierError("response_draft_version_lookup_failed", { phase: "response_draft_write", messageId });
  const latest = Array.isArray(data) && data[0]?.draft_version ? Number(data[0].draft_version) : 0;
  return latest + 1;
}

async function insertResponseDraft(
  supabase: ServiceClient,
  values: {
    input: ResponseDraftInput;
    actorId: string;
    promptHash: string;
    inputHash: string;
    promptVersion: string;
    model: string;
    draftVersion: number;
    validationStatus: "valid" | "invalid" | "error";
    validationErrors: string[];
    safetyFlags: string[];
    draft?: Partial<ValidResponseDraft>;
    errorCode?: string;
    operationMode?: "generate_response" | "regenerate_response";
    selectorDraftId?: string | null;
  },
) {
  const nowIso = new Date().toISOString();
  const messageId = String(values.input.message.id || "");
  const classificationId = values.input.classification.id;

  const { data: previousCurrentDrafts, error: previousCurrentError } = await supabase
    .from("email_response_drafts")
    .select("id, draft_version, validation_status, draft_status, created_at")
    .eq("message_id", messageId)
    .eq("is_current", true)
    .order("draft_version", { ascending: false });
  if (previousCurrentError) {
    throw new ClassifierError("response_draft_previous_lookup_failed", { phase: "response_draft_write", messageId });
  }

  const { error: supersedeError } = await supabase
    .from("email_response_drafts")
    .update({ is_current: false, superseded_at: nowIso })
    .eq("message_id", messageId)
    .eq("is_current", true);
  if (supersedeError) {
    throw new ClassifierError("response_draft_supersede_failed", { phase: "response_draft_write", messageId });
  }

  const normalizedSafetyFlags = uniqueStrings(values.safetyFlags, RESPONSE_DRAFT_SAFETY_FLAGS.length)
    .filter((flag) => RESPONSE_DRAFT_SAFETY_FLAGS.includes(flag as typeof RESPONSE_DRAFT_SAFETY_FLAGS[number]));
  const metadata = {
    generator_name: RESPONSE_DRAFT_GENERATOR_NAME,
    generator_version: RESPONSE_DRAFT_GENERATOR_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
    link_context_version: LINK_CONTEXT_VERSION,
    verified_order_context_version: VERIFIED_ORDER_CONTEXT_VERSION,
    verified_context: values.input.verified_order_context.summary,
    safety_policy_version: values.input.draft_context.safety_policy_version,
    effective_classification: {
      category: values.input.classification.effective_category,
      priority: values.input.classification.effective_priority,
      urgency: values.input.classification.effective_urgency,
      has_operator_override: values.input.classification.has_operator_override,
      classification_review_state: values.input.classification.classification_review_state,
      refund_risk: values.input.classification.refund_risk,
      chargeback_risk: values.input.classification.chargeback_risk,
      customer_risk: values.input.classification.customer_risk,
      response_timing: values.input.classification.response_timing,
      recommended_action: values.input.classification.recommended_action,
    },
    body_meta: {
      body_source: values.input.body.source,
      body_truncated: values.input.body.body_truncated,
      body_chars_original: values.input.body.body_chars_original,
      body_chars_sent: values.input.body.body_chars_sent,
      truncation_strategy: values.input.body.truncation_strategy,
    },
    tone: values.draft?.tone || null,
    response_strategy: values.draft?.response_strategy || null,
    error_code: values.errorCode || null,
    operation: {
      mode: values.operationMode || "generate_response",
      regenerated_from_draft_id: values.selectorDraftId || null,
      previous_current_draft_ids: (previousCurrentDrafts || []).map((draft: Record<string, any>) => draft.id),
      previous_current_versions: (previousCurrentDrafts || []).map((draft: Record<string, any>) => Number(draft.draft_version)).filter(Number.isFinite),
      superseded_at: previousCurrentDrafts?.length ? nowIso : null,
      generated_at: nowIso,
    },
  };

  const { data, error } = await supabase
    .from("email_response_drafts")
    .insert({
      message_id: messageId,
      classification_id: classificationId,
      source: "ai",
      draft_status: "generated",
      draft_subject: values.draft?.draft_subject || null,
      draft_body_text: values.draft?.draft_body_text || null,
      draft_body_format: "plain_text",
      model_name: values.model,
      model_version: null,
      prompt_version: values.promptVersion,
      prompt_hash: values.promptHash,
      input_hash: values.inputHash,
      draft_version: values.draftVersion,
      is_current: true,
      superseded_at: null,
      validation_status: values.validationStatus,
      validation_errors: values.validationErrors,
      safety_flags: normalizedSafetyFlags,
      requires_human_review: true,
      created_by: values.actorId,
      metadata,
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new ClassifierError("response_draft_insert_failed", { phase: "response_draft_write", messageId });
  }
  return String(data.id);
}

async function generateResponseDraft(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string; email: string | null },
  operationMode: "generate_response" | "regenerate_response" = "generate_response",
) {
  const promptVersionValue = responseDraftPromptVersion();
  const prompt = buildResponseDraftPrompt(promptVersionValue);
  const promptHash = await sha256Hex(stableStringify({
    prompt,
    generator_version: RESPONSE_DRAFT_GENERATOR_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
    safety_flags: RESPONSE_DRAFT_SAFETY_FLAGS,
    schema: responseDraftJsonSchema(),
  }));
  const model = responseDraftModelName();
  const draftInput = await loadResponseDraftInput(supabase, input, promptVersionValue);
  const inputHash = await sha256Hex(stableStringify({
    generator_name: RESPONSE_DRAFT_GENERATOR_NAME,
    generator_version: RESPONSE_DRAFT_GENERATOR_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
    prompt_hash: promptHash,
    input: draftInput,
  }));
  const draftVersion = await nextDraftVersion(supabase, String(draftInput.message.id));

  try {
    const aiOutput = await callOpenAIResponseDraft(draftInput, prompt, model);
    const validation = validateResponseDraft(aiOutput, draftInput);
    if (validation.ok) {
      const draftId = await insertResponseDraft(supabase, {
        input: draftInput,
        actorId: admin.userId,
        promptHash,
        inputHash,
        promptVersion: promptVersionValue,
        model,
        draftVersion,
        validationStatus: "valid",
        validationErrors: [],
        safetyFlags: validation.value.safety_flags,
        draft: validation.value,
        operationMode,
        selectorDraftId: input.draftId,
      });
      return {
        ok: true,
        mode: operationMode,
        draft_id: draftId,
        message_id: draftInput.message.id,
        classification_id: draftInput.classification.id,
        draft_version: draftVersion,
        validation_status: "valid",
        safety_flags: validation.value.safety_flags,
        requires_human_review: true,
        model_name: model,
        prompt_version: promptVersionValue,
        prompt_hash: promptHash,
        input_hash: inputHash,
        verified_context: draftInput.verified_order_context.summary,
        regenerated_from_draft_id: operationMode === "regenerate_response" ? input.draftId : null,
        generated_body_returned: false,
        outbound_send_enabled: false,
        outlook_mutation_performed: false,
      };
    }

    const draftId = await insertResponseDraft(supabase, {
      input: draftInput,
      actorId: admin.userId,
      promptHash,
      inputHash,
      promptVersion: promptVersionValue,
      model,
      draftVersion,
      validationStatus: "invalid",
      validationErrors: validation.validationErrors,
      safetyFlags: validation.safetyFlags,
      draft: validation.safeOutput,
      operationMode,
      selectorDraftId: input.draftId,
    });
    return {
      ok: true,
      mode: operationMode,
      draft_id: draftId,
      message_id: draftInput.message.id,
      classification_id: draftInput.classification.id,
      draft_version: draftVersion,
      validation_status: "invalid",
      validation_errors: validation.validationErrors,
      safety_flags: validation.safetyFlags,
      requires_human_review: true,
      model_name: model,
      prompt_version: promptVersionValue,
      prompt_hash: promptHash,
      input_hash: inputHash,
      verified_context: draftInput.verified_order_context.summary,
      regenerated_from_draft_id: operationMode === "regenerate_response" ? input.draftId : null,
      generated_body_returned: false,
      outbound_send_enabled: false,
      outlook_mutation_performed: false,
    };
  } catch (error) {
    const safe = safeError(error);
    const draftId = await insertResponseDraft(supabase, {
      input: draftInput,
      actorId: admin.userId,
      promptHash,
      inputHash,
      promptVersion: promptVersionValue,
      model,
      draftVersion,
      validationStatus: safe.code === "response_draft_malformed_json" ? "invalid" : "error",
      validationErrors: [safe.code],
      safetyFlags: safe.code === "response_draft_malformed_json"
        ? ["requires_human_review", "malformed_json"]
        : ["requires_human_review"],
      errorCode: safe.code,
      operationMode,
      selectorDraftId: input.draftId,
    });
    return {
      ok: true,
      mode: operationMode,
      draft_id: draftId,
      message_id: draftInput.message.id,
      classification_id: draftInput.classification.id,
      draft_version: draftVersion,
      validation_status: safe.code === "response_draft_malformed_json" ? "invalid" : "error",
      validation_errors: [safe.code],
      safety_flags: safe.code === "response_draft_malformed_json" ? ["requires_human_review", "malformed_json"] : ["requires_human_review"],
      requires_human_review: true,
      model_name: model,
      prompt_version: promptVersionValue,
      prompt_hash: promptHash,
      input_hash: inputHash,
      verified_context: draftInput.verified_order_context.summary,
      regenerated_from_draft_id: operationMode === "regenerate_response" ? input.draftId : null,
      generated_body_returned: false,
      outbound_send_enabled: false,
      outlook_mutation_performed: false,
    };
  }
}

async function loadDraftForOperatorWorkflow(supabase: ServiceClient, input: Input) {
  const { data, error } = await supabase
    .from("email_response_drafts")
    .select("id, message_id, classification_id, source, draft_status, draft_subject, draft_body_text, draft_body_format, model_name, model_version, prompt_version, prompt_hash, input_hash, processing_job_id, draft_version, is_current, superseded_at, validation_status, validation_errors, safety_flags, requires_human_review, created_by, approved_by, approved_at, rejected_by, rejected_at, operator_notes, metadata, created_at, updated_at")
    .eq("id", input.draftId)
    .maybeSingle();
  if (error) throw new ClassifierError("response_draft_lookup_failed", { phase: "draft_review" });
  if (!data?.id) throw new ClassifierError("response_draft_not_found", { status: 404, phase: "draft_review" });
  if (input.messageId && data.message_id !== input.messageId) {
    throw new ClassifierError("response_draft_message_mismatch", { status: 400, phase: "draft_review" });
  }
  if (input.classificationId && data.classification_id && data.classification_id !== input.classificationId) {
    throw new ClassifierError("response_draft_classification_mismatch", { status: 400, phase: "draft_review" });
  }
  if (data.is_current !== true) {
    throw new ClassifierError("current_response_draft_required", { status: 400, phase: "draft_review" });
  }
  return data as Record<string, any>;
}

async function saveDraftReview(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string; email: string | null },
) {
  const sourceDraft = await loadDraftForOperatorWorkflow(supabase, input);
  const nowIso = new Date().toISOString();
  const messageId = String(sourceDraft.message_id);
  const draftVersion = await nextDraftVersion(supabase, messageId);
  const priorMetadata = sourceDraft.metadata && typeof sourceDraft.metadata === "object" ? sourceDraft.metadata : {};
  const metadata = {
    ...priorMetadata,
    operator_review: {
      mode: "save_draft_review",
      reviewed_from_draft_id: sourceDraft.id,
      reviewed_from_version: sourceDraft.draft_version,
      reviewed_from_source: sourceDraft.source,
      reviewed_by: admin.userId,
      reviewed_at: nowIso,
      original_ai_draft_id: priorMetadata?.operator_review?.original_ai_draft_id || (sourceDraft.source === "ai" ? sourceDraft.id : null),
      original_ai_version: priorMetadata?.operator_review?.original_ai_version || (sourceDraft.source === "ai" ? sourceDraft.draft_version : null),
    },
  };

  const { data: previousCurrentDrafts, error: previousCurrentError } = await supabase
    .from("email_response_drafts")
    .select("id, draft_version")
    .eq("message_id", messageId)
    .eq("is_current", true)
    .order("draft_version", { ascending: false });
  if (previousCurrentError) {
    throw new ClassifierError("response_draft_previous_lookup_failed", { phase: "draft_review", messageId });
  }

  const { error: supersedeError } = await supabase
    .from("email_response_drafts")
    .update({ is_current: false, superseded_at: nowIso })
    .eq("message_id", messageId)
    .eq("is_current", true);
  if (supersedeError) {
    throw new ClassifierError("response_draft_supersede_failed", { phase: "draft_review", messageId });
  }

  const { data, error } = await supabase
    .from("email_response_drafts")
    .insert({
      message_id: messageId,
      classification_id: sourceDraft.classification_id || null,
      source: "human",
      draft_status: "reviewing",
      draft_subject: input.draftSubject,
      draft_body_text: input.draftBodyText,
      draft_body_format: sourceDraft.draft_body_format || "plain_text",
      model_name: sourceDraft.model_name || null,
      model_version: sourceDraft.model_version || null,
      prompt_version: sourceDraft.prompt_version || null,
      prompt_hash: sourceDraft.prompt_hash || null,
      input_hash: sourceDraft.input_hash || null,
      processing_job_id: sourceDraft.processing_job_id || null,
      draft_version: draftVersion,
      is_current: true,
      superseded_at: null,
      validation_status: sourceDraft.validation_status || "not_validated",
      validation_errors: Array.isArray(sourceDraft.validation_errors) ? sourceDraft.validation_errors : [],
      safety_flags: safeArray(sourceDraft.safety_flags),
      requires_human_review: true,
      created_by: admin.userId,
      operator_notes: input.operatorNotes || null,
      metadata: {
        ...metadata,
        operation: {
          mode: "save_draft_review",
          previous_current_draft_ids: (previousCurrentDrafts || []).map((draft: Record<string, any>) => draft.id),
          previous_current_versions: (previousCurrentDrafts || []).map((draft: Record<string, any>) => Number(draft.draft_version)).filter(Number.isFinite),
          superseded_at: previousCurrentDrafts?.length ? nowIso : null,
        },
      },
    })
    .select("id, message_id, classification_id, source, draft_status, draft_subject, draft_body_text, draft_body_format, draft_version, is_current, validation_status, validation_errors, safety_flags, requires_human_review, approved_by, approved_at, rejected_by, rejected_at, operator_notes, metadata, created_at, updated_at")
    .single();
  if (error || !data?.id) {
    throw new ClassifierError("response_draft_review_insert_failed", { phase: "draft_review", messageId });
  }

  return {
    ok: true,
    mode: "save_draft_review",
    draft: safeDraftSummary(data, true),
    draft_id: data.id,
    message_id: messageId,
    classification_id: sourceDraft.classification_id || null,
    draft_version: draftVersion,
    draft_status: "reviewing",
    reviewed_from_draft_id: sourceDraft.id,
    outbound_send_enabled: false,
    outlook_mutation_performed: false,
  };
}

async function transitionDraftReviewStatus(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string; email: string | null },
  nextStatus: "approved" | "rejected",
) {
  const draft = await loadDraftForOperatorWorkflow(supabase, input);
  const submittedSubject = input.draftSubject ?? draft.draft_subject ?? "";
  const submittedBodyText = input.draftBodyText ?? draft.draft_body_text ?? "";
  if (
    nextStatus === "approved" &&
    input.draftSubject !== null &&
    input.draftBodyText !== null &&
    (submittedSubject !== (draft.draft_subject || "") || submittedBodyText !== (draft.draft_body_text || ""))
  ) {
    const saved = await saveDraftReview(supabase, input, admin);
    return await transitionDraftReviewStatus(supabase, {
      ...input,
      draftId: saved.draft_id,
      draftSubject: null,
      draftBodyText: null,
    }, admin, nextStatus);
  }

  const nowIso = new Date().toISOString();
  const metadata = {
    ...(draft.metadata && typeof draft.metadata === "object" ? draft.metadata : {}),
    operator_review_status: {
      mode: nextStatus === "approved" ? "approve_draft" : "reject_draft",
      previous_status: draft.draft_status,
      reviewed_by: admin.userId,
      reviewed_at: nowIso,
    },
  };
  const patch = nextStatus === "approved"
    ? {
      draft_status: "approved",
      approved_by: admin.userId,
      approved_at: nowIso,
      rejected_by: null,
      rejected_at: null,
      operator_notes: input.operatorNotes ?? draft.operator_notes ?? null,
      metadata,
    }
    : {
      draft_status: "rejected",
      rejected_by: admin.userId,
      rejected_at: nowIso,
      approved_by: null,
      approved_at: null,
      operator_notes: input.operatorNotes ?? draft.operator_notes ?? null,
      metadata,
    };

  const { data, error } = await supabase
    .from("email_response_drafts")
    .update(patch)
    .eq("id", draft.id)
    .eq("is_current", true)
    .select("id, message_id, classification_id, source, draft_status, draft_subject, draft_body_text, draft_body_format, draft_version, is_current, validation_status, validation_errors, safety_flags, requires_human_review, approved_by, approved_at, rejected_by, rejected_at, operator_notes, metadata, created_at, updated_at")
    .single();
  if (error || !data?.id) {
    throw new ClassifierError("response_draft_status_update_failed", { phase: "draft_review", messageId: draft.message_id });
  }

  return {
    ok: true,
    mode: nextStatus === "approved" ? "approve_draft" : "reject_draft",
    draft: safeDraftSummary(data, true),
    draft_id: data.id,
    message_id: data.message_id,
    classification_id: data.classification_id || null,
    draft_version: data.draft_version,
    draft_status: data.draft_status,
    approved_by: data.approved_by || null,
    approved_at: data.approved_at || null,
    rejected_by: data.rejected_by || null,
    rejected_at: data.rejected_at || null,
    outbound_send_enabled: false,
    outlook_mutation_performed: false,
  };
}

const DRAFT_CONTENT_BLOCKING_FLAGS = new Set([
  "unsupported_claim",
  "unsafe_refund_promise",
  "unsafe_compensation_promise",
  "unsafe_legal_admission",
  "unsafe_escalation_language",
  "fabricated_order_detail",
  "fabricated_shipping_update",
  "fabricated_timeline",
  "fabricated_tracking_information",
  "fabricated_inventory_promise",
  "category_mismatch",
  "empty_draft",
  "draft_too_long",
  "malformed_json",
]);

function draftContentIsSafe(row: Record<string, any>) {
  if (row.validation_status !== "valid") return false;
  const flags = safeArray(row.safety_flags);
  return !flags.some((flag) => DRAFT_CONTENT_BLOCKING_FLAGS.has(flag));
}

function safeDraftSummary(row: Record<string, any>, includeDraftBody: boolean) {
  const canIncludeContent = includeDraftBody && draftContentIsSafe(row);
  const contentOmittedReason = includeDraftBody
    ? canIncludeContent ? null : "draft_content_not_safe_to_return"
    : "draft_content_not_requested";

  return {
    id: row.id,
    message_id: row.message_id,
    classification_id: row.classification_id || null,
    draft_version: row.draft_version,
    draft_status: row.draft_status,
    validation_status: row.validation_status,
    validation_errors: Array.isArray(row.validation_errors) ? row.validation_errors : [],
    safety_flags: safeArray(row.safety_flags),
    requires_human_review: row.requires_human_review !== false,
    created_at: row.created_at,
    created_by: row.created_by || null,
    approved_by: row.approved_by || null,
    approved_at: row.approved_at || null,
    rejected_by: row.rejected_by || null,
    rejected_at: row.rejected_at || null,
    operator_notes: row.operator_notes || null,
    is_current: row.is_current === true,
    superseded_at: row.superseded_at || null,
    source: row.source,
    draft_body_format: row.draft_body_format,
    model_name: row.model_name || null,
    model_version: row.model_version || null,
    prompt_version: row.prompt_version || null,
    prompt_hash: row.prompt_hash || null,
    input_hash: row.input_hash || null,
    metadata: safeMetadata(row.metadata || {}),
    draft_subject: canIncludeContent ? shortText(row.draft_subject, MAX_DRAFT_SUBJECT_CHARS) || null : null,
    draft_body_text: canIncludeContent ? safeBodyText(row.draft_body_text) : null,
    draft_content_returned: canIncludeContent,
    draft_content_omitted_reason: contentOmittedReason,
  };
}

async function adminDraftView(supabase: ServiceClient, input: Input) {
  let query = supabase
    .from("email_response_drafts")
    .select("id, message_id, classification_id, source, draft_status, draft_subject, draft_body_text, draft_body_format, model_name, model_version, prompt_version, prompt_hash, input_hash, processing_job_id, draft_version, is_current, superseded_at, validation_status, validation_errors, safety_flags, requires_human_review, created_by, approved_by, approved_at, rejected_by, rejected_at, operator_notes, metadata, created_at, updated_at");

  if (input.draftId) {
    query = query.eq("id", input.draftId);
  } else {
    if (input.messageId) query = query.eq("message_id", input.messageId);
    if (input.classificationId) query = query.eq("classification_id", input.classificationId);
  }

  query = query
    .order("created_at", { ascending: false })
    .limit(input.draftId ? 1 : input.limit);

  const { data, error } = await query;
  if (error) throw new ClassifierError("admin_draft_view_failed", { phase: "admin_draft_view" });
  if (input.draftId && !data?.length) {
    throw new ClassifierError("response_draft_not_found", { status: 404, phase: "admin_draft_view" });
  }

  const drafts = (data || []).map((row: Record<string, any>) => safeDraftSummary(row, input.includeDraftBody));
  return {
    ok: true,
    mode: "admin_draft_view",
    drafts,
    draft_count: drafts.length,
    include_draft_body_requested: input.includeDraftBody,
    outbound_send_enabled: false,
    outlook_mutation_performed: false,
  };
}

async function loadSelectedMessages(supabase: ServiceClient, input: Input) {
  if (input.classificationRunId) {
    const { data: rows, error } = await supabase
      .from("email_message_classifications")
      .select("message_id, email_messages!inner(id, mailbox_id, received_at, sync_status)")
      .eq("classification_run_id", input.classificationRunId)
      .limit(input.limit);
    if (error) throw new ClassifierError("classification_run_lookup_failed", { phase: "message_select" });
    return (rows || [])
      .map((row: Record<string, any>) => row.email_messages)
      .filter((message: Record<string, unknown> | null) => message?.sync_status === "active")
      .map((message: Record<string, unknown>) => ({ id: String(message.id), mailbox_id: String(message.mailbox_id) }));
  }

  let query = supabase
    .from("email_messages")
    .select("id, mailbox_id")
    .eq("sync_status", "active")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(input.limit);
  if (input.messageId) query = query.eq("id", input.messageId);
  if (input.mailboxId) query = query.eq("mailbox_id", input.mailboxId);
  if (input.startDate) query = query.gte("received_at", input.startDate);
  if (input.endDate) query = query.lte("received_at", input.endDate);

  const { data, error } = await query;
  if (error) throw new ClassifierError("message_select_failed", { phase: "message_select" });
  if (input.messageId && !data?.length) throw new ClassifierError("message_not_found", { status: 404, phase: "message_select" });
  return (data || []).map((message: Record<string, unknown>) => ({
    id: String(message.id),
    mailbox_id: String(message.mailbox_id),
  }));
}

async function dryRunClassifications(
  supabase: ServiceClient,
  input: Input,
  prompt: string,
  promptHash: string,
  promptVersionValue: string,
  model: string,
) {
  const counters = blankDryRunCounters();
  const messages = await loadSelectedMessages(supabase, input);
  for (const message of messages) {
    counters.messages_tested += 1;
    try {
      const classifierInput = await loadClassifierInput(supabase, message.id, promptVersionValue);
      await sha256Hex(stableStringify({
        classifier_name: CLASSIFIER_NAME,
        classifier_version: CLASSIFIER_VERSION,
        taxonomy_version: TAXONOMY_VERSION,
        prompt_hash: promptHash,
        input_version: classifierInputVersion(promptHash),
        input: classifierInput,
      }));
      const aiOutput = await callOpenAI(classifierInput, prompt, model);
      const validation = validateClassification(aiOutput, classifierInput);
      if (validation.ok) {
        counters.valid_outputs += 1;
        counters.would_classify += 1;
      } else {
        counters.invalid_outputs += 1;
      }
    } catch (error) {
      const safe = safeError(error);
      counters.invalid_outputs += 1;
      console.error("[microsoft-email-classify] dry-run message failed", {
        phase: safe.phase,
        error: safe.code,
        message_id: message.id,
      });
    }
  }
  return counters;
}

async function existingReplayOperation(supabase: ServiceClient, input: Input) {
  if (!input.idempotencyKey) return null;
  const { data, error } = await supabase
    .from("email_operational_events")
    .select("id, new_job_ids, payload")
    .eq("event_type", "classification_replay")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (error) throw new ClassifierError("idempotency_lookup_failed", { phase: "idempotency_lookup" });
  return data as Record<string, any> | null;
}

async function activeClassifyMessageIds(supabase: ServiceClient, messageIds: string[]) {
  const active = new Set<string>();
  if (!messageIds.length) return active;
  for (let index = 0; index < messageIds.length; index += 100) {
    const { data, error } = await supabase
      .from("email_processing_jobs")
      .select("message_id")
      .in("message_id", messageIds.slice(index, index + 100))
      .eq("job_type", "classify")
      .in("status", ACTIVE_JOB_STATUSES);
    if (error) throw new ClassifierError("active_job_lookup_failed", { phase: "active_job_lookup" });
    for (const row of data || []) active.add(String(row.message_id));
  }
  return active;
}

async function replayClassification(
  supabase: ServiceClient,
  input: Input,
  admin: { userId: string; email: string | null },
  promptHash: string,
  promptVersionValue: string,
) {
  const existing = await existingReplayOperation(supabase, input);
  if (existing) {
    const payload = existing.payload && typeof existing.payload === "object" ? existing.payload : {};
    return {
      ok: true,
      mode: "replay_classification",
      idempotent: true,
      jobs_enqueued: Number(payload.jobs_enqueued || 0),
      jobs_skipped_active: Number(payload.jobs_skipped_active || 0),
      operation_id: existing.id,
      operational_event_id: existing.id,
    };
  }

  const messages = await loadSelectedMessages(supabase, input);
  const messageIds = messages.map((message) => message.id);
  const active = await activeClassifyMessageIds(supabase, messageIds);
  const operationId = crypto.randomUUID();
  const inputVersion = `v1:classification_replay:${operationId}:${CLASSIFIER_VERSION}`;
  const rows = messages
    .filter((message) => !active.has(message.id))
    .map((message) => ({
      message_id: message.id,
      job_type: "classify",
      input_version: inputVersion,
      status: "queued",
      priority: 65,
      attempt_count: 0,
      max_attempts: 3,
      available_at: new Date().toISOString(),
      metadata: {
        classifier_name: CLASSIFIER_NAME,
        classifier_version: CLASSIFIER_VERSION,
        prompt_hash: promptHash,
        prompt_version: promptVersionValue,
        replay_source: input.replaySource,
        replay_reason: input.reason,
        operational_event_id: operationId,
        replay_selector: {
          message_id: input.messageId,
          mailbox_id: input.mailboxId,
          start_date: input.startDate,
          end_date: input.endDate,
          classification_run_id: input.classificationRunId,
        },
      },
    }));

  const { data: inserted, error: insertError } = rows.length
    ? await supabase.from("email_processing_jobs").insert(rows).select("id")
    : { data: [], error: null };
  if (insertError) throw new ClassifierError("replay_job_insert_failed", { phase: "job_insert" });
  const newJobIds = (inserted || []).map((row: { id: string }) => row.id);
  const mailboxIds = [...new Set(messages.map((message) => message.mailbox_id).filter(Boolean))];
  const payload = {
    messages_selected: messageIds.length,
    jobs_enqueued: newJobIds.length,
    jobs_skipped_active: messageIds.length - rows.length,
    input_version: inputVersion,
    classifier_name: CLASSIFIER_NAME,
    classifier_version: CLASSIFIER_VERSION,
    prompt_version: promptVersionValue,
    replay_selector: {
      message_id: input.messageId,
      mailbox_id: input.mailboxId,
      start_date: input.startDate,
      end_date: input.endDate,
      classification_run_id: input.classificationRunId,
      limit: input.limit,
    },
  };

  const { data: event, error: eventError } = await supabase
    .from("email_operational_events")
    .insert({
      id: operationId,
      event_type: "classification_replay",
      mailbox_id: mailboxIds.length === 1 ? mailboxIds[0] : input.mailboxId,
      message_ids: messageIds,
      job_ids: [],
      new_job_ids: newJobIds,
      job_types: ["classify"],
      reason: input.reason,
      initiated_by: admin.userId,
      initiated_by_email: admin.email,
      processor_version: CLASSIFIER_VERSION,
      replay_source: input.replaySource,
      idempotency_key: input.idempotencyKey,
      payload,
    })
    .select("id")
    .single();
  if (eventError || !event?.id) throw new ClassifierError("audit_insert_failed", { phase: "audit_insert" });

  return {
    ok: true,
    mode: "replay_classification",
    jobs_enqueued: newJobIds.length,
    jobs_skipped_active: messageIds.length - rows.length,
    operation_id: operationId,
    operational_event_id: String(event.id),
  };
}

function safeError(error: unknown, job?: ProcessingJob) {
  if (error instanceof ClassifierError) return error;
  return new ClassifierError("unexpected_error", {
    jobId: job?.id,
    messageId: job?.message_id,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  const counters = blankCounters();
  try {
    const supabase = serviceClient();
    const admin = await requireAdmin(req, supabase);
    const input = await parseInput(req);

    if (input.mode === "admin_view") {
      return json(req, 200, await adminClassificationView(supabase, input));
    }

    if (input.mode === "message_detail") {
      return json(req, 200, await adminMessageDetail(supabase, input));
    }

    if (input.mode === "admin_context_view") {
      return json(req, 200, await adminContextView(supabase, input));
    }

    if (input.mode === "operator_match_context") {
      return json(req, 200, await operatorMatchContext(supabase, input));
    }

    if (input.mode === "confirm_match") {
      return json(req, 200, await updateMatchReviewStatus(supabase, input, admin, "confirmed"));
    }

    if (input.mode === "reject_match") {
      return json(req, 200, await updateMatchReviewStatus(supabase, input, admin, "rejected"));
    }

    if (input.mode === "mark_match_stale") {
      return json(req, 200, await updateMatchReviewStatus(supabase, input, admin, "stale"));
    }

    if (input.mode === "save_review") {
      return json(req, 200, await saveClassificationReview(supabase, input, admin));
    }

    if (input.mode === "generate_response") {
      return json(req, 200, await generateResponseDraft(supabase, input, admin));
    }

    if (input.mode === "regenerate_response") {
      return json(req, 200, await generateResponseDraft(supabase, input, admin, "regenerate_response"));
    }

    if (input.mode === "admin_draft_view") {
      return json(req, 200, await adminDraftView(supabase, input));
    }

    if (input.mode === "save_draft_review") {
      return json(req, 200, await saveDraftReview(supabase, input, admin));
    }

    if (input.mode === "approve_draft") {
      return json(req, 200, await transitionDraftReviewStatus(supabase, input, admin, "approved"));
    }

    if (input.mode === "reject_draft") {
      return json(req, 200, await transitionDraftReviewStatus(supabase, input, admin, "rejected"));
    }

    const promptVersionValue = promptVersion();
    const prompt = buildPrompt(promptVersionValue);
    const promptHash = await sha256Hex(stableStringify({
      prompt,
      classifier_version: CLASSIFIER_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
      truncation_version: TRUNCATION_VERSION,
      link_context_version: LINK_CONTEXT_VERSION,
      schema: jsonSchema(),
    }));
    const model = ["dry_run", "process_queued", "enqueue_and_process", "process_message"].includes(input.mode)
      ? modelName()
      : "";

    if (input.mode === "dry_run") {
      return json(req, 200, {
        ok: true,
        mode: input.mode,
        ...await dryRunClassifications(supabase, input, prompt, promptHash, promptVersionValue, model),
      });
    }

    if (input.mode === "replay_classification") {
      return json(req, 200, await replayClassification(supabase, input, admin, promptHash, promptVersionValue));
    }

    if (["enqueue_only", "enqueue_and_process", "process_message"].includes(input.mode)) {
      counters.jobs_enqueued = await enqueueJobs(supabase, input, promptHash);
    }
    if (["process_queued", "enqueue_and_process", "process_message"].includes(input.mode)) {
      await processQueuedJobs(supabase, input, admin.userId, counters, prompt, promptHash, promptVersionValue, model);
    }

    return json(req, 200, {
      ok: true,
      mode: input.mode,
      ...counters,
    });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-email-classify] failed", {
      phase: safe.phase,
      error: safe.code,
    });
    return json(req, safe.status, { ok: false, error: safe.code, mode: "unknown", ...counters });
  }
});
