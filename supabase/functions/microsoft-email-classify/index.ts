import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLASSIFIER_NAME = "og-email-triage-classifier";
const CLASSIFIER_VERSION = "4b.3-v1";
const TAXONOMY_VERSION = "step-4b.3-v1";
const TRUNCATION_VERSION = "head-12000-tail-2000-v1";
const LINK_CONTEXT_VERSION = "links-compact-v1";
const HEAD_CHARS = 12000;
const TAIL_CHARS = 2000;
const MAX_LIMIT = 50;
const OPENAI_TIMEOUT_MS = 30000;

const SUPPORTED_MODES = ["enqueue_only", "process_queued", "enqueue_and_process", "process_message"] as const;
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
] as const;
const ENTITY_KEYS = ["order_numbers", "item_numbers", "buyer_usernames", "tracking_numbers"] as const;
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
  response_needed: boolean;
  human_review_required: boolean;
  confidence: number;
  summary: string;
  recommended_action: string;
  detected_entities: Record<string, string[]>;
  reasoning_summary: string;
  safety_flags: string[];
};
type Counters = {
  jobs_enqueued: number;
  jobs_processed: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_skipped: number;
  classifications_created: number;
};
type Input = {
  mode: Mode;
  limit: number;
  messageId: string | null;
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

  return { userId: user.id };
}

async function parseInput(req: Request): Promise<Input> {
  const body = await req.json().catch(() => ({}));
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  const mode = SUPPORTED_MODES.includes(requestedMode as Mode) ? requestedMode as Mode : "enqueue_and_process";
  const limit = Math.min(Math.max(Number(body?.limit) || 25, 1), MAX_LIMIT);
  const messageId = typeof body?.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : null;
  if (mode === "process_message" && !messageId) {
    throw new ClassifierError("message_id_required", { status: 400, phase: "input" });
  }
  return { mode, limit, messageId };
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

function uniqueStrings(values: unknown[], maxItems = 20) {
  return [...new Set(values.map((value) => cleanWhitespace(value)).filter(Boolean))].slice(0, maxItems);
}

function promptVersion() {
  return requiredEnv("EMAIL_CLASSIFIER_PROMPT_VERSION");
}

function modelName() {
  return requiredEnv("OPENAI_EMAIL_CLASSIFIER_MODEL");
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
Allowed recommended_action values: ${RECOMMENDED_ACTIONS.join(", ")}.
Allowed safety_flags values: ${SAFETY_FLAGS.join(", ")}.

Use only the supplied stored email context. Do not infer facts that are not supported.
Set human_review_required true for low confidence, ambiguity, account security, refunds, returns, cancellations, item-not-received, item-not-as-described, payment issues, or order-impacting decisions.
If confidence is below 0.60, use category "internal_or_other", recommended_action "review_only", human_review_required true, and include "low_confidence" in safety_flags.
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
      subcategory: { type: "string" },
      priority: { type: "string", enum: PRIORITIES },
      urgency: { type: "string", enum: URGENCIES },
      response_needed: { type: "boolean" },
      human_review_required: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string", maxLength: 220 },
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
      reasoning_summary: { type: "string", maxLength: 220 },
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

function validateClassification(value: unknown): { ok: true; value: ValidClassification } | { ok: false; errors: string[]; safeOutput: Record<string, unknown> | null } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["output_not_object"], safeOutput: null };
  }
  const row = value as Record<string, unknown>;
  const category = String(row.category || "");
  const priority = String(row.priority || "");
  const urgency = String(row.urgency || "");
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
  if (!RECOMMENDED_ACTIONS.includes(recommendedAction as typeof RECOMMENDED_ACTIONS[number])) errors.push("invalid_recommended_action");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push("invalid_confidence");
  if (!summary || summary.length > 220) errors.push("invalid_summary");
  if (!reasoningSummary || reasoningSummary.length > 220) errors.push("invalid_reasoning_summary");
  if (!detected) errors.push("invalid_detected_entities");
  if (!safetyFlags) errors.push("invalid_safety_flags");

  const detectedEntities: Record<string, string[]> = {};
  if (detected) {
    for (const key of ENTITY_KEYS) {
      const values = detected[key];
      if (!Array.isArray(values)) errors.push(`invalid_detected_entities_${key}`);
      detectedEntities[key] = Array.isArray(values) ? uniqueStrings(values, 20) : [];
    }
  }
  const normalizedSafetyFlags = uniqueStrings(safetyFlags || [], SAFETY_FLAGS.length);
  for (const flag of normalizedSafetyFlags) {
    if (!SAFETY_FLAGS.includes(flag as typeof SAFETY_FLAGS[number])) errors.push("invalid_safety_flag");
  }

  const responseNeeded = row.response_needed;
  const humanReviewRequired = row.human_review_required;
  if (typeof responseNeeded !== "boolean") errors.push("invalid_response_needed");
  if (typeof humanReviewRequired !== "boolean") errors.push("invalid_human_review_required");

  const subcategory = cleanWhitespace(row.subcategory || "unclassifiable").slice(0, 80) || "unclassifiable";
  const safeOutput = {
    category,
    subcategory,
    priority,
    urgency,
    response_needed: responseNeeded === true,
    human_review_required: humanReviewRequired !== false,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    summary: summary.slice(0, 220),
    recommended_action: recommendedAction,
    detected_entities: detectedEntities,
    reasoning_summary: reasoningSummary.slice(0, 220),
    safety_flags: normalizedSafetyFlags.filter((flag) => SAFETY_FLAGS.includes(flag as typeof SAFETY_FLAGS[number])),
  };

  if (errors.length) return { ok: false, errors: [...new Set(errors)], safeOutput };
  return { ok: true, value: safeOutput as ValidClassification };
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
      .eq("classifier_version", CLASSIFIER_VERSION)
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
    const validation = validateClassification(aiOutput);
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
    const model = modelName();

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
