import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deterministicMatchEmail, DeterministicMatcherError } from "../_shared/deterministic-email-matcher.ts";

const PROCESSOR_VERSION = "v1";
const DEFAULT_JOB_TYPES = ["normalize", "match_order"] as const;
const SUPPORTED_JOB_TYPES = ["normalize", "match_order"] as const;
const SUPPORTED_MODES = ["enqueue_only", "process_queued", "enqueue_and_process", "process_message", "rematch_existing"] as const;
const MAX_LIMIT = 100;
const NORMALIZED_TEXT_LIMIT = 200000;

type ServiceClient = ReturnType<typeof createClient>;
type JobType = typeof SUPPORTED_JOB_TYPES[number];
type ProcessMode = typeof SUPPORTED_MODES[number];

type ProcessInput = {
  mode: ProcessMode;
  limit: number;
  messageId: string | null;
  jobTypes: JobType[];
};

type EmailMessage = {
  id: string;
  subject: string | null;
  body_preview: string | null;
  from_email: string | null;
  from_name: string | null;
  sender_email: string | null;
  sender_name: string | null;
  received_at: string | null;
  sync_status: string;
};

type EmailBody = {
  body_text: string | null;
  body_html: string | null;
  normalized_text: string | null;
  normalized_text_sha256: string | null;
  normalization_version: string | null;
};

type EmailRecipient = {
  recipient_type: string;
  display_name: string | null;
  email: string | null;
  email_normalized: string | null;
};

type ProcessingJob = {
  id: string;
  message_id: string;
  job_type: JobType;
  status: string;
  attempt_count: number | null;
  max_attempts: number | null;
};

type Counters = {
  jobs_enqueued: number;
  jobs_processed: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_skipped: number;
  links_created: number;
  links_updated: number;
};

type RematchCounters = {
  scanned: number;
  rematched: number;
  links_created: number;
  links_updated: number;
  ambiguous: number;
  skipped: number;
  failed: number;
};

class ProcessError extends Error {
  code: string;
  status: number;
  phase: string;
  jobId?: string;
  messageId?: string;

  constructor(
    code: string,
    options: { status?: number; phase?: string; jobId?: string; messageId?: string } = {},
  ) {
    super(code);
    this.name = "ProcessError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "process";
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
  if (!value) throw new ProcessError("configuration_error", { phase: "configuration" });
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

async function requireAdmin(req: Request) {
  const supabase = serviceClient();
  const accessToken = getBearerToken(req);
  if (!accessToken) return { ok: false as const, status: 401, error: "unauthorized" };

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) return { ok: false as const, status: 401, error: "unauthorized" };

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) return { ok: false as const, status: 500, error: "configuration_error" };
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    return { ok: false as const, status: 403, error: "admin_required" };
  }

  return { ok: true as const, userId: user.id, email: user.email || null };
}

async function parseInput(req: Request): Promise<ProcessInput> {
  const body = await req.json().catch(() => ({}));
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  const mode = SUPPORTED_MODES.includes(requestedMode as ProcessMode)
    ? requestedMode as ProcessMode
    : "enqueue_and_process";
  const limit = Math.min(Math.max(Number(body?.limit) || 50, 1), MAX_LIMIT);
  const messageId = typeof body?.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : null;
  const requestedJobTypes = Array.isArray(body?.jobTypes) ? body.jobTypes : DEFAULT_JOB_TYPES;
  const jobTypes = requestedJobTypes
    .map((value: unknown) => String(value || "").trim())
    .filter((value: string): value is JobType => SUPPORTED_JOB_TYPES.includes(value as JobType));

  if (mode === "process_message" && !messageId) {
    throw new ProcessError("message_id_required", { status: 400, phase: "input" });
  }

  return {
    mode,
    limit,
    messageId,
    jobTypes: jobTypes.length ? [...new Set(jobTypes)] : [...DEFAULT_JOB_TYPES],
  };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, "/");
}

function stripHtml(html: string) {
  return decodeEntities(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, NORMALIZED_TEXT_LIMIT);
}

async function loadMessageContext(supabase: ServiceClient, messageId: string) {
  const { data: message, error: messageError } = await supabase
    .from("email_messages")
    .select("id, subject, body_preview, from_email, from_name, sender_email, sender_name, received_at, sync_status")
    .eq("id", messageId)
    .maybeSingle();

  if (messageError) throw new ProcessError("matching_failed", { phase: "message_lookup", messageId });
  if (!message) throw new ProcessError("message_not_found", { status: 404, phase: "message_lookup", messageId });

  const { data: body, error: bodyError } = await supabase
    .from("email_message_bodies")
    .select("body_text, body_html, normalized_text, normalized_text_sha256, normalization_version")
    .eq("message_id", messageId)
    .maybeSingle();

  if (bodyError) throw new ProcessError("normalization_failed", { phase: "body_lookup", messageId });

  const { data: recipients, error: recipientsError } = await supabase
    .from("email_message_recipients")
    .select("recipient_type, display_name, email, email_normalized")
    .eq("message_id", messageId);

  if (recipientsError) throw new ProcessError("matching_failed", { phase: "recipient_lookup", messageId });

  return {
    message: message as EmailMessage,
    body: body as EmailBody | null,
    recipients: (recipients || []) as EmailRecipient[],
  };
}

async function normalizeMessage(supabase: ServiceClient, messageId: string) {
  const context = await loadMessageContext(supabase, messageId);
  if (context.body?.normalized_text && context.body.normalization_version === PROCESSOR_VERSION) {
    return { skipped: true, metadata: { processor_version: PROCESSOR_VERSION, normalized: false, reason: "already_normalized_v1" } };
  }

  const source = context.body?.body_text || (context.body?.body_html ? stripHtml(context.body.body_html) : context.message.body_preview || "");
  const normalizedText = normalizeText(source);
  const normalizedHash = normalizedText ? await sha256Hex(normalizedText) : null;
  const nowIso = new Date().toISOString();
  const bodyPatch: Record<string, unknown> = {
    message_id: messageId,
    normalized_text: normalizedText || null,
    normalized_text_sha256: normalizedHash,
    normalization_version: PROCESSOR_VERSION,
    metadata: {
      ...(context.body ? {} : { source: "microsoft-email-process" }),
      normalization_processor: PROCESSOR_VERSION,
    },
    stored_at: nowIso,
    updated_at: nowIso,
  };
  if (!context.body) bodyPatch.redaction_status = "body_omitted";

  const { error } = await supabase.from("email_message_bodies").upsert(bodyPatch, { onConflict: "message_id" });

  if (error) throw new ProcessError("normalization_failed", { phase: "body_update", messageId });
  return {
    skipped: !normalizedText,
    metadata: {
      processor_version: PROCESSOR_VERSION,
      normalized: Boolean(normalizedText),
      normalized_text_sha256: normalizedHash,
    },
  };
}

async function enqueueJobs(supabase: ServiceClient, input: ProcessInput) {
  let query = supabase
    .from("email_messages")
    .select("id")
    .eq("sync_status", "active")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(input.limit);

  if (input.messageId) query = query.eq("id", input.messageId);
  const { data: messages, error } = await query;
  if (error) throw new ProcessError("enqueue_failed", { phase: "message_select" });

  const rows = (messages || []).flatMap((message: { id: string }) =>
    input.jobTypes.map((jobType) => ({
      message_id: message.id,
      job_type: jobType,
      input_version: PROCESSOR_VERSION,
      status: "queued",
      priority: jobType === "normalize" ? 50 : 60,
      metadata: { processor_version: PROCESSOR_VERSION, enqueue_source: "microsoft-email-process" },
    }))
  );

  if (!rows.length) return 0;
  const { data, error: insertError } = await supabase
    .from("email_processing_jobs")
    .upsert(rows, { onConflict: "message_id,job_type,input_version", ignoreDuplicates: true })
    .select("id");

  if (insertError) throw new ProcessError("enqueue_failed", { phase: "job_insert" });
  return data?.length || 0;
}

async function claimQueuedJobs(supabase: ServiceClient, input: ProcessInput, processLimit: number) {
  let query = supabase
    .from("email_processing_jobs")
    .select("id, message_id, job_type, status, attempt_count, max_attempts")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .in("job_type", input.jobTypes)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(processLimit);

  if (input.messageId) query = query.eq("message_id", input.messageId);
  const { data, error } = await query;
  if (error) throw new ProcessError("job_claim_failed", { phase: "job_select" });
  return (data || []) as ProcessingJob[];
}

async function markJob(
  supabase: ServiceClient,
  job: ProcessingJob,
  status: "running" | "succeeded" | "failed" | "skipped",
  values: Record<string, unknown> = {},
) {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status,
    ...values,
  };
  if (status === "running") {
    patch.started_at = nowIso;
    patch.locked_at = nowIso;
    patch.locked_by = "microsoft-email-process";
    patch.attempt_count = Number(job.attempt_count || 0) + 1;
  }
  if (["succeeded", "failed", "skipped"].includes(status)) {
    patch.completed_at = nowIso;
    patch.locked_at = null;
    patch.locked_by = null;
  }

  const { data, error } = await supabase
    .from("email_processing_jobs")
    .update(patch)
    .eq("id", job.id)
    .eq(status === "running" ? "status" : "id", status === "running" ? "queued" : job.id)
    .select("id")
    .maybeSingle();

  if (error || !data?.id) throw new ProcessError("job_claim_failed", { phase: "job_update", jobId: job.id, messageId: job.message_id });
}

async function processJob(supabase: ServiceClient, job: ProcessingJob) {
  await markJob(supabase, job, "running");

  try {
    if (job.job_type === "normalize") {
      const result = await normalizeMessage(supabase, job.message_id);
      await markJob(supabase, job, result.skipped ? "skipped" : "succeeded", {
        last_error_code: null,
        last_error_message: null,
        metadata: result.metadata,
      });
      return {
        status: result.skipped ? "skipped" as const : "succeeded" as const,
        links_created: 0,
        links_updated: 0,
      };
    }

    const result = await deterministicMatchEmail(supabase, job.message_id);
    await markJob(supabase, job, result.skipped ? "skipped" : "succeeded", {
      last_error_code: null,
      last_error_message: null,
      metadata: result.metadata,
    });
    return {
      status: result.skipped ? "skipped" as const : "succeeded" as const,
      links_created: result.links_created,
      links_updated: result.links_updated,
    };
  } catch (error) {
    const safe = safeError(error, job);
    await markJob(supabase, job, "failed", {
      last_error_code: safe.code,
      last_error_message: safe.code,
      metadata: {
        processor_version: PROCESSOR_VERSION,
        error: safe.code,
        phase: safe.phase,
      },
    }).catch(() => undefined);
    throw safe;
  }
}

async function processQueuedJobs(supabase: ServiceClient, input: ProcessInput, counters: Counters) {
  const processLimit = ["enqueue_and_process", "process_message"].includes(input.mode)
    ? Math.min(input.limit * input.jobTypes.length, MAX_LIMIT * SUPPORTED_JOB_TYPES.length)
    : input.limit;
  const jobs = await claimQueuedJobs(supabase, input, processLimit);
  for (const job of jobs) {
    try {
      const result = await processJob(supabase, job);
      counters.jobs_processed += 1;
      if (result.status === "succeeded") counters.jobs_succeeded += 1;
      if (result.status === "skipped") counters.jobs_skipped += 1;
      counters.links_created += result.links_created;
      counters.links_updated += result.links_updated;
    } catch (error) {
      const safe = safeError(error, job);
      counters.jobs_processed += 1;
      counters.jobs_failed += 1;
      console.error("[microsoft-email-process] job failed", {
        phase: safe.phase,
        error: safe.code,
        job_id: job.id,
        message_id: job.message_id,
        job_type: job.job_type,
      });
    }
  }
}

async function loadRematchCandidateIds(supabase: ServiceClient, input: ProcessInput) {
  let query = supabase
    .from("email_messages")
    .select("id, mailbox_id")
    .eq("sync_status", "active")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(input.limit);

  if (input.messageId) query = query.eq("id", input.messageId);
  const { data, error } = await query;
  if (error) throw new ProcessError("rematch_failed", { phase: "rematch_message_select", messageId: input.messageId || undefined });
  return (data || []).map((message: { id: string; mailbox_id?: string | null }) => ({
    id: message.id,
    mailbox_id: message.mailbox_id || null,
  })).filter((message) => Boolean(message.id));
}

async function insertRematchOperationalEvent(
  supabase: ServiceClient,
  values: {
    mailboxId: string | null;
    messageIds: string[];
    initiatedBy: string;
    initiatedByEmail: string | null;
    payload: Record<string, unknown>;
  },
) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .insert({
      event_type: "rematch_existing",
      mailbox_id: values.mailboxId,
      message_ids: values.messageIds,
      job_types: ["match_order"],
      reason: "Operator-triggered deterministic rematch of existing imported emails. No Outlook fetch, Outlook mutation, eBay mutation, classification, draft generation, or sending is performed.",
      initiated_by: values.initiatedBy,
      initiated_by_email: values.initiatedByEmail,
      replay_source: "rematch_existing",
      payload: values.payload,
    })
    .select("id, created_at")
    .single();

  if (error || !data?.id) {
    console.error("[microsoft-email-process] rematch audit insert failed", {
      phase: "rematch_existing_audit",
      mailbox_id: values.mailboxId,
    });
    throw new ProcessError("rematch_event_failed", { phase: "rematch_existing_audit" });
  }

  return data as { id: string; created_at: string };
}

async function rematchExistingMessages(
  supabase: ServiceClient,
  input: ProcessInput,
  admin: { userId: string; email: string | null },
) {
  const startedAt = Date.now();
  const counters: RematchCounters = {
    scanned: 0,
    rematched: 0,
    links_created: 0,
    links_updated: 0,
    ambiguous: 0,
    skipped: 0,
    failed: 0,
  };
  const candidates = await loadRematchCandidateIds(supabase, input);
  const messageIds = candidates.map((message) => message.id);
  const mailboxId = candidates.find((message) => message.mailbox_id)?.mailbox_id || null;
  const failures: Array<Record<string, unknown>> = [];

  for (const messageId of messageIds) {
    counters.scanned += 1;
    try {
      const result = await deterministicMatchEmail(supabase, messageId);
      counters.links_created += result.links_created;
      counters.links_updated += result.links_updated;
      if (result.skipped) counters.skipped += 1;
      else counters.rematched += 1;

      const ambiguity = result.metadata?.ambiguity;
      if (ambiguity && typeof ambiguity === "object" && Object.keys(ambiguity as Record<string, unknown>).length) {
        counters.ambiguous += 1;
      }
    } catch (error) {
      const safe = safeError(error, { id: "", message_id: messageId, job_type: "match_order", status: "failed", attempt_count: null, max_attempts: null });
      counters.failed += 1;
      failures.push({
        message_id: messageId,
        error: safe.code,
        phase: safe.phase,
      });
      console.error("[microsoft-email-process] rematch failed", {
        phase: safe.phase,
        error: safe.code,
        message_id: messageId,
      });
    }
  }

  const safety = {
    outlook_fetch_performed: false,
    outlook_mutation_performed: false,
    ebay_mutation_performed: false,
    classification_triggered: false,
    drafts_created: 0,
    automatic_responses_sent: 0,
  };
  const auditEvent = await insertRematchOperationalEvent(supabase, {
    mailboxId,
    messageIds,
    initiatedBy: admin.userId,
    initiatedByEmail: admin.email,
    payload: {
      mode: "rematch_existing",
      limit: input.limit,
      scanned: counters.scanned,
      rematched: counters.rematched,
      links_created: counters.links_created,
      links_updated: counters.links_updated,
      ambiguous: counters.ambiguous,
      skipped: counters.skipped,
      failed: counters.failed,
      duration_ms: Date.now() - startedAt,
      status: counters.failed > 0 ? "completed_with_failures" : "completed",
      safety,
    },
  });

  return {
    ...counters,
    limit: input.limit,
    message_ids: messageIds,
    failures,
    operation_event_id: auditEvent.id,
    replay_operation_reference: {
      operation_event_id: auditEvent.id,
      operation_event_created_at: auditEvent.created_at,
    },
    safety,
  };
}

function blankCounters(): Counters {
  return {
    jobs_enqueued: 0,
    jobs_processed: 0,
    jobs_succeeded: 0,
    jobs_failed: 0,
    jobs_skipped: 0,
    links_created: 0,
    links_updated: 0,
  };
}

function safeError(error: unknown, job?: ProcessingJob) {
  if (error instanceof ProcessError) return error;
  if (error instanceof DeterministicMatcherError) {
    return new ProcessError(error.code, {
      status: error.status,
      phase: error.phase,
      messageId: error.messageId || job?.message_id,
      jobId: job?.id,
    });
  }
  return new ProcessError("unexpected_error", {
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
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const input = await parseInput(req);
    if (input.mode === "rematch_existing") {
      const result = await rematchExistingMessages(supabase, input, admin);
      return json(req, 200, {
        ok: true,
        mode: input.mode,
        ...result,
      });
    }

    if (["enqueue_only", "enqueue_and_process", "process_message"].includes(input.mode)) {
      counters.jobs_enqueued = await enqueueJobs(supabase, input);
    }
    if (["process_queued", "enqueue_and_process", "process_message"].includes(input.mode)) {
      await processQueuedJobs(supabase, input, counters);
    }

    return json(req, 200, {
      ok: true,
      mode: input.mode,
      ...counters,
    });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-email-process] failed", {
      phase: safe.phase,
      error: safe.code,
      message_id: safe.messageId,
      job_id: safe.jobId,
    });
    return json(req, safe.status, { ok: false, error: safe.code, ...counters });
  }
});
