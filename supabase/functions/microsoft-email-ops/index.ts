import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROCESSOR_VERSION = "v1";
const SUPPORTED_MODES = [
  "mailbox_health",
  "sync_status",
  "processing_queue_status",
  "matching_statistics",
  "requeue_failed_jobs",
  "replay_processing",
  "resume_sync_replay",
] as const;
const SUPPORTED_JOB_TYPES = ["normalize", "match_order"] as const;
const ACTIVE_JOB_STATUSES = ["queued", "running"];
const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "skipped"];
const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "skipped"];
const MAX_PAGE_SIZE = 100;
const MAX_OPERATION_MESSAGES = 500;
const MAX_OPERATION_JOBS = 500;

type ServiceClient = ReturnType<typeof createClient>;
type OpsMode = typeof SUPPORTED_MODES[number];
type JobType = typeof SUPPORTED_JOB_TYPES[number];
type Operator = { actorType: "service_role"; userId: null; email: null } | { actorType: "admin"; userId: string; email: string | null };

type OpsInput = {
  mode: OpsMode;
  mailboxId: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  page: number;
  pageSize: number;
  jobIds: string[];
  jobTypes: JobType[];
  messageId: string | null;
  syncRunId: string | null;
  reason: string;
  failureCategory: string | null;
  operationalNotes: string | null;
  replaySource: string;
  idempotencyKey: string | null;
  execute: boolean;
  maxPages: number;
  pageSizeForSync: number;
};

class OpsError extends Error {
  code: string;
  status: number;
  phase: string;

  constructor(code: string, options: { status?: number; phase?: string } = {}) {
    super(code);
    this.name = "OpsError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "ops";
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
  if (!value) throw new OpsError("configuration_error", { phase: "configuration" });
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

async function requireOperator(req: Request, supabase: ServiceClient): Promise<Operator> {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new OpsError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new OpsError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new OpsError("configuration_error", { phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new OpsError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

async function parseInput(req: Request): Promise<OpsInput> {
  const body = await req.json().catch(() => ({}));
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  if (!SUPPORTED_MODES.includes(requestedMode as OpsMode)) {
    throw new OpsError("invalid_mode", { status: 400, phase: "input" });
  }

  const requestedJobTypes = Array.isArray(body?.jobTypes) ? body.jobTypes : SUPPORTED_JOB_TYPES;
  const jobTypes = requestedJobTypes
    .map((value: unknown) => String(value || "").trim())
    .filter((value: string): value is JobType => SUPPORTED_JOB_TYPES.includes(value as JobType));

  const reason = String(body?.reason || "").trim();
  if (["requeue_failed_jobs", "replay_processing", "resume_sync_replay"].includes(requestedMode) && !reason) {
    throw new OpsError("reason_required", { status: 400, phase: "input" });
  }

  return {
    mode: requestedMode as OpsMode,
    mailboxId: stringOrNull(body?.mailboxId),
    status: stringOrNull(body?.status),
    startDate: stringOrNull(body?.startDate),
    endDate: stringOrNull(body?.endDate),
    page: Math.max(Number(body?.page) || 1, 1),
    pageSize: Math.min(Math.max(Number(body?.pageSize) || 50, 1), MAX_PAGE_SIZE),
    jobIds: Array.isArray(body?.jobIds) ? body.jobIds.map((value: unknown) => String(value || "").trim()).filter(Boolean) : [],
    jobTypes: jobTypes.length ? [...new Set(jobTypes)] : [...SUPPORTED_JOB_TYPES],
    messageId: stringOrNull(body?.messageId),
    syncRunId: stringOrNull(body?.syncRunId),
    reason,
    failureCategory: stringOrNull(body?.failureCategory),
    operationalNotes: stringOrNull(body?.operationalNotes),
    replaySource: stringOrNull(body?.replaySource) || "microsoft-email-ops",
    idempotencyKey: stringOrNull(body?.idempotencyKey),
    execute: body?.execute !== false,
    maxPages: Math.min(Math.max(Number(body?.maxPages) || 1, 1), 5),
    pageSizeForSync: Math.min(Math.max(Number(body?.syncPageSize) || 25, 1), 50),
  };
}

function stringOrNull(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

function secondsBetween(start?: string | null, end?: string | null) {
  if (!start) return null;
  const startTime = Date.parse(start);
  const endTime = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.max(Math.round((endTime - startTime) / 1000), 0);
}

function operationReason(input: OpsInput) {
  return input.reason.slice(0, 500);
}

function operationInputVersion(kind: "requeue" | "replay", operationId: string) {
  return `${PROCESSOR_VERSION}:${kind}:${operationId}`;
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function jobKey(messageId: string, jobType: string) {
  return `${messageId}:${jobType}`;
}

function cleanErrorMessage(value: unknown) {
  return String(value || "").slice(0, 200);
}

async function existingOperation(supabase: ServiceClient, input: OpsInput) {
  if (!input.idempotencyKey) return null;
  const { data, error } = await supabase
    .from("email_operational_events")
    .select("id, event_type, mailbox_id, sync_run_id, message_ids, job_ids, new_job_ids, job_types, reason, replay_source, payload, created_at")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();

  if (error) throw new OpsError("idempotency_lookup_failed", { phase: "idempotency_lookup" });
  return data;
}

async function insertOperationalEvent(
  supabase: ServiceClient,
  values: {
    id: string;
    eventType: "processing_requeue" | "processing_replay" | "sync_replay";
    mailboxId?: string | null;
    syncRunId?: string | null;
    messageIds?: string[];
    jobIds?: string[];
    newJobIds?: string[];
    jobTypes?: string[];
    input: OpsInput;
    operator: Operator;
    payload: Record<string, unknown>;
  },
) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .insert({
      id: values.id,
      event_type: values.eventType,
      mailbox_id: values.mailboxId || null,
      sync_run_id: values.syncRunId || null,
      message_ids: unique(values.messageIds || []),
      job_ids: unique(values.jobIds || []),
      new_job_ids: unique(values.newJobIds || []),
      job_types: unique(values.jobTypes || []),
      reason: operationReason(values.input),
      initiated_by: values.operator.userId,
      initiated_by_email: values.operator.email,
      failure_category: values.input.failureCategory,
      operational_notes: values.input.operationalNotes,
      processor_version: PROCESSOR_VERSION,
      replay_source: values.input.replaySource,
      idempotency_key: values.input.idempotencyKey,
      payload: values.payload,
    })
    .select("id, created_at")
    .single();

  if (error || !data?.id) throw new OpsError("audit_insert_failed", { phase: "audit_insert" });
  return data as { id: string; created_at: string };
}

async function countRows(supabase: ServiceClient, table: string, build: (query: any) => any) {
  const query = build(supabase.from(table).select("id", { count: "exact", head: true }));
  const { count, error } = await query;
  if (error) throw new OpsError("count_failed", { phase: `${table}_count` });
  return count || 0;
}

async function mailboxHealth(supabase: ServiceClient, input: OpsInput) {
  let mailboxQuery = supabase
    .from("email_mailboxes")
    .select("id, mailbox_email, display_name, status, sync_enabled, last_sync_at, last_error_code, last_error_at, updated_at")
    .order("updated_at", { ascending: false });
  if (input.mailboxId) mailboxQuery = mailboxQuery.eq("id", input.mailboxId);
  const { data: mailboxes, error: mailboxError } = await mailboxQuery.limit(100);
  if (mailboxError) throw new OpsError("mailbox_health_failed", { phase: "mailbox_lookup" });

  const rows = [];
  for (const mailbox of mailboxes || []) {
    const { data: syncStates, error: stateError } = await supabase
      .from("email_sync_states")
      .select("id, status, last_successful_sync_at, last_attempted_sync_at, last_error_code, last_error_at, consecutive_error_count, delta_link, metadata, updated_at")
      .eq("mailbox_id", mailbox.id)
      .order("updated_at", { ascending: false });
    if (stateError) throw new OpsError("mailbox_health_failed", { phase: "sync_state_lookup" });

    const latestState = (syncStates || [])[0] || null;
    const stateMetadata = latestState?.metadata && typeof latestState.metadata === "object" ? latestState.metadata as Record<string, unknown> : {};
    const lastSuccessfulSync = latestState?.last_successful_sync_at || mailbox.last_sync_at || null;
    const backlog = await processingCounts(supabase, { mailboxId: mailbox.id, activeOnly: true });

    rows.push({
      mailbox_id: mailbox.id,
      mailbox_email: mailbox.mailbox_email,
      display_name: mailbox.display_name,
      mailbox_status: mailbox.status,
      sync_enabled: mailbox.sync_enabled,
      active: mailbox.status === "active" && mailbox.sync_enabled === true,
      last_successful_sync_at: lastSuccessfulSync,
      sync_age_seconds: secondsBetween(lastSuccessfulSync),
      current_delta_token_present: Boolean(latestState?.delta_link),
      current_sync_state: latestState
        ? {
          id: latestState.id,
          status: latestState.status,
          last_attempted_sync_at: latestState.last_attempted_sync_at,
          last_successful_sync_at: latestState.last_successful_sync_at,
          updated_at: latestState.updated_at,
        }
        : null,
      last_sync_failure: {
        mailbox_error_code: mailbox.last_error_code,
        mailbox_error_at: mailbox.last_error_at,
        sync_state_error_code: latestState?.last_error_code || null,
        sync_state_error_at: latestState?.last_error_at || null,
      },
      consecutive_failures: Number(latestState?.consecutive_error_count || 0),
      processing_backlog_counts: backlog,
      resumable: latestState?.status === "syncing" && stateMetadata.continuation_link ? true : false,
      reset_required: latestState?.status === "reset_required",
    });
  }

  return { ok: true, mailboxes: rows };
}

async function processingCounts(supabase: ServiceClient, options: { mailboxId?: string | null; activeOnly?: boolean }) {
  const statuses = options.activeOnly ? ACTIVE_JOB_STATUSES : JOB_STATUSES;
  const counts: Record<string, number> = {};
  const byJobType: Record<string, Record<string, number>> = {};

  for (const status of statuses) {
    counts[status] = await countRows(supabase, "email_processing_jobs", (query) => {
      let next = query.eq("status", status);
      if (options.mailboxId) {
        next = next.select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
          .eq("email_messages.mailbox_id", options.mailboxId);
      }
      return next;
    });
  }

  for (const jobType of SUPPORTED_JOB_TYPES) {
    byJobType[jobType] = {};
    for (const status of statuses) {
      byJobType[jobType][status] = await countRows(supabase, "email_processing_jobs", (query) => {
        let next = query.eq("status", status).eq("job_type", jobType);
        if (options.mailboxId) {
          next = next.select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
            .eq("email_messages.mailbox_id", options.mailboxId);
        }
        return next;
      });
    }
  }

  return { by_status: counts, by_job_type: byJobType };
}

async function syncStatus(supabase: ServiceClient, input: OpsInput) {
  const from = (input.page - 1) * input.pageSize;
  const to = from + input.pageSize - 1;
  let query = supabase
    .from("email_sync_runs")
    .select("id, mailbox_id, folder_id, sync_state_id, run_type, status, started_at, completed_at, trigger_source, graph_request_count, pages_fetched, messages_seen, messages_inserted, messages_updated, messages_deleted, attachments_seen, jobs_enqueued, last_error_code, last_error_message, metadata", { count: "exact" })
    .order("started_at", { ascending: false })
    .range(from, to);
  if (input.mailboxId) query = query.eq("mailbox_id", input.mailboxId);
  if (input.status) query = query.eq("status", input.status);
  if (input.startDate) query = query.gte("started_at", input.startDate);
  if (input.endDate) query = query.lte("started_at", input.endDate);

  const { data, error, count } = await query;
  if (error) throw new OpsError("sync_status_failed", { phase: "sync_runs_lookup" });

  const runs = (data || []).map((run: Record<string, any>) => ({
    id: run.id,
    mailbox_id: run.mailbox_id,
    folder_id: run.folder_id,
    sync_state_id: run.sync_state_id,
    run_type: run.run_type,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_seconds: secondsBetween(run.started_at, run.completed_at),
    trigger_source: run.trigger_source,
    graph_request_count: run.graph_request_count,
    pages_fetched: run.pages_fetched,
    messages_seen: run.messages_seen,
    messages_inserted: run.messages_inserted,
    messages_updated: run.messages_updated,
    tombstones_processed: run.messages_deleted,
    attachments_seen: run.attachments_seen,
    jobs_enqueued: run.jobs_enqueued,
    retry_count: Number(run.metadata?.retry_count || 0),
    error_summary: run.last_error_code
      ? { code: run.last_error_code, message: cleanErrorMessage(run.last_error_message) }
      : null,
    metadata_summary: {
      delta_checkpoint_saved: run.metadata?.delta_checkpoint_saved === true,
      partial_sync: run.metadata?.partial_sync === true,
      more_pages_available: run.metadata?.more_pages_available === true,
      resumed_from_continuation: run.metadata?.resumed_from_continuation === true,
    },
  }));

  return { ok: true, page: input.page, page_size: input.pageSize, total: count || 0, runs };
}

async function processingQueueStatus(supabase: ServiceClient, input: OpsInput) {
  const counts = await processingCounts(supabase, { mailboxId: input.mailboxId, activeOnly: false });
  let oldestQuery = supabase
    .from("email_processing_jobs")
    .select("id, message_id, job_type, status, priority, attempt_count, max_attempts, available_at, created_at, last_error_code, email_messages!inner(mailbox_id)")
    .eq("status", "queued")
    .order("available_at", { ascending: true })
    .limit(10);
  if (input.mailboxId) oldestQuery = oldestQuery.eq("email_messages.mailbox_id", input.mailboxId);
  const { data: oldest, error: oldestError } = await oldestQuery;
  if (oldestError) throw new OpsError("queue_status_failed", { phase: "oldest_pending_lookup" });

  let retryQuery = supabase
    .from("email_processing_jobs")
    .select("id, message_id, job_type, status, attempt_count, max_attempts, last_error_code, completed_at, email_messages!inner(mailbox_id)")
    .in("status", ["failed", "running"])
    .order("updated_at", { ascending: false })
    .limit(50);
  if (input.mailboxId) retryQuery = retryQuery.eq("email_messages.mailbox_id", input.mailboxId);
  const { data: retryRows, error: retryError } = await retryQuery;
  if (retryError) throw new OpsError("queue_status_failed", { phase: "retry_lookup" });

  const retryVisibility = (retryRows || []).map((job: Record<string, any>) => ({
    id: job.id,
    message_id: job.message_id,
    job_type: job.job_type,
    status: job.status,
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    retry_exhausted: Number(job.attempt_count || 0) >= Number(job.max_attempts || 0),
    last_error_code: job.last_error_code,
    completed_at: job.completed_at,
  }));

  return {
    ok: true,
    counts,
    oldest_pending_jobs: (oldest || []).map((job: Record<string, any>) => ({
      id: job.id,
      message_id: job.message_id,
      job_type: job.job_type,
      priority: job.priority,
      attempt_count: job.attempt_count,
      max_attempts: job.max_attempts,
      available_at: job.available_at,
      created_at: job.created_at,
    })),
    retry_visibility: retryVisibility,
    dead_letter_visibility: retryVisibility.filter((job) => job.retry_exhausted),
  };
}

async function matchingStatistics(supabase: ServiceClient, input: OpsInput) {
  const confirmed = await linkCount(supabase, input, "confirmed");
  const suggested = await linkCount(supabase, input, "suggested");
  const ambiguous = await ambiguousJobCount(supabase, input);
  const unmatchedMessages = await unmatchedMessageCount(supabase, input);
  const confidenceDistribution = await confidenceBuckets(supabase, input);

  return {
    ok: true,
    confirmed_links: confirmed,
    suggested_links: suggested,
    ambiguous_matches: ambiguous,
    confidence_distribution: confidenceDistribution,
    unmatched_message_counts: unmatchedMessages,
  };
}

async function linkCount(supabase: ServiceClient, input: OpsInput, status: string) {
  return await countRows(supabase, "email_message_links", (query) => {
    let next = query.eq("status", status);
    if (input.mailboxId) {
      next = next.select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", input.mailboxId);
    }
    return next;
  });
}

async function ambiguousJobCount(supabase: ServiceClient, input: OpsInput) {
  let query = supabase
    .from("email_processing_jobs")
    .select("id, metadata, email_messages!inner(mailbox_id)", { count: "exact" })
    .eq("job_type", "match_order")
    .in("status", TERMINAL_JOB_STATUSES)
    .limit(1000);
  if (input.mailboxId) query = query.eq("email_messages.mailbox_id", input.mailboxId);
  const { data, error } = await query;
  if (error) throw new OpsError("matching_statistics_failed", { phase: "ambiguity_lookup" });
  return (data || []).filter((job: Record<string, any>) => {
    const ambiguity = job.metadata?.ambiguity;
    return ambiguity && typeof ambiguity === "object" && Object.keys(ambiguity).length > 0;
  }).length;
}

async function unmatchedMessageCount(supabase: ServiceClient, input: OpsInput) {
  let messagesQuery = supabase
    .from("email_messages")
    .select("id")
    .eq("sync_status", "active")
    .limit(5000);
  if (input.mailboxId) messagesQuery = messagesQuery.eq("mailbox_id", input.mailboxId);
  if (input.startDate) messagesQuery = messagesQuery.gte("received_at", input.startDate);
  if (input.endDate) messagesQuery = messagesQuery.lte("received_at", input.endDate);
  const { data: messages, error: messagesError } = await messagesQuery;
  if (messagesError) throw new OpsError("matching_statistics_failed", { phase: "message_lookup" });

  const messageIds = (messages || []).map((row: { id: string }) => row.id);
  if (!messageIds.length) return { total_active_sampled: 0, unmatched: 0, sample_limited: false };

  const linkedIds = new Set<string>();
  for (let index = 0; index < messageIds.length; index += 100) {
    const { data, error } = await supabase
      .from("email_message_links")
      .select("message_id")
      .in("message_id", messageIds.slice(index, index + 100))
      .in("status", ["suggested", "confirmed"]);
    if (error) throw new OpsError("matching_statistics_failed", { phase: "link_lookup" });
    for (const row of data || []) linkedIds.add(String(row.message_id));
  }

  return {
    total_active_sampled: messageIds.length,
    unmatched: messageIds.length - linkedIds.size,
    sample_limited: messageIds.length >= 5000,
  };
}

async function confidenceBuckets(supabase: ServiceClient, input: OpsInput) {
  let query = supabase
    .from("email_message_links")
    .select("confidence, status, email_messages!inner(mailbox_id)")
    .in("status", ["suggested", "confirmed"])
    .limit(5000);
  if (input.mailboxId) query = query.eq("email_messages.mailbox_id", input.mailboxId);
  const { data, error } = await query;
  if (error) throw new OpsError("matching_statistics_failed", { phase: "confidence_lookup" });

  const buckets = {
    "0.00-0.49": 0,
    "0.50-0.69": 0,
    "0.70-0.89": 0,
    "0.90-1.00": 0,
    unknown: 0,
  };
  for (const row of data || []) {
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence)) buckets.unknown += 1;
    else if (confidence < 0.5) buckets["0.00-0.49"] += 1;
    else if (confidence < 0.7) buckets["0.50-0.69"] += 1;
    else if (confidence < 0.9) buckets["0.70-0.89"] += 1;
    else buckets["0.90-1.00"] += 1;
  }
  return buckets;
}

async function activeJobKeys(supabase: ServiceClient, messageIds: string[], jobTypes: string[]) {
  const keys = new Set<string>();
  if (!messageIds.length || !jobTypes.length) return keys;
  for (let index = 0; index < messageIds.length; index += 100) {
    const { data, error } = await supabase
      .from("email_processing_jobs")
      .select("message_id, job_type")
      .in("message_id", messageIds.slice(index, index + 100))
      .in("job_type", jobTypes)
      .in("status", ACTIVE_JOB_STATUSES);
    if (error) throw new OpsError("active_job_lookup_failed", { phase: "active_job_lookup" });
    for (const row of data || []) keys.add(jobKey(String(row.message_id), String(row.job_type)));
  }
  return keys;
}

async function requeueFailedJobs(supabase: ServiceClient, input: OpsInput, operator: Operator) {
  const existing = await existingOperation(supabase, input);
  if (existing) return { ok: true, idempotent: true, event: existing, ...(existing.payload || {}) };

  let query = supabase
    .from("email_processing_jobs")
    .select("id, message_id, job_type, attempt_count, max_attempts, last_error_code, input_version, created_at, completed_at, email_messages!inner(mailbox_id, received_at, sync_status)")
    .eq("status", "failed")
    .in("job_type", input.jobTypes)
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(MAX_OPERATION_JOBS);
  if (input.jobIds.length) query = query.in("id", input.jobIds);
  if (input.mailboxId) query = query.eq("email_messages.mailbox_id", input.mailboxId);
  if (input.startDate) query = query.gte("completed_at", input.startDate);
  if (input.endDate) query = query.lte("completed_at", input.endDate);

  const { data: failedJobs, error } = await query;
  if (error) throw new OpsError("requeue_lookup_failed", { phase: "failed_job_lookup" });

  const operationId = crypto.randomUUID();
  const messageIds = unique((failedJobs || []).map((job: Record<string, any>) => job.message_id));
  const activeKeys = await activeJobKeys(supabase, messageIds, input.jobTypes);
  const inputVersion = operationInputVersion("requeue", operationId);
  const rows = [];
  const skippedActive: string[] = [];

  for (const job of (failedJobs || []) as Array<Record<string, any>>) {
    const key = jobKey(String(job.message_id), String(job.job_type));
    if (activeKeys.has(key)) {
      skippedActive.push(String(job.id));
      continue;
    }
    rows.push({
      message_id: job.message_id,
      job_type: job.job_type,
      status: "queued",
      priority: job.job_type === "normalize" ? 45 : 55,
      attempt_count: 0,
      max_attempts: job.max_attempts || 3,
      available_at: new Date().toISOString(),
      input_version: inputVersion,
      metadata: {
        processor_version: PROCESSOR_VERSION,
        replay_source: input.replaySource,
        operational_event_id: operationId,
        retry_reason: operationReason(input),
        retry_failure_category: input.failureCategory,
        previous_job_id: job.id,
        previous_attempt_count: job.attempt_count,
        previous_error_code: job.last_error_code,
        previous_input_version: job.input_version,
      },
    });
    activeKeys.add(key);
  }

  const newJobIds = await insertJobs(supabase, rows);
  await insertOperationalEvent(supabase, {
    id: operationId,
    eventType: "processing_requeue",
    mailboxId: input.mailboxId,
    messageIds,
    jobIds: (failedJobs || []).map((job: Record<string, any>) => job.id),
    newJobIds,
    jobTypes: input.jobTypes,
    input,
    operator,
    payload: {
      selected_failed_jobs: (failedJobs || []).length,
      new_jobs_enqueued: newJobIds.length,
      skipped_due_to_active_jobs: skippedActive.length,
      skipped_active_job_ids: skippedActive,
      input_version: inputVersion,
    },
  });

  return {
    ok: true,
    event_id: operationId,
    selected_failed_jobs: (failedJobs || []).length,
    new_jobs_enqueued: newJobIds.length,
    skipped_due_to_active_jobs: skippedActive.length,
    new_job_ids: newJobIds,
  };
}

async function insertJobs(supabase: ServiceClient, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return [];
  const { data, error } = await supabase
    .from("email_processing_jobs")
    .insert(rows)
    .select("id");
  if (error) throw new OpsError("job_insert_failed", { phase: "job_insert" });
  return (data || []).map((row: { id: string }) => row.id);
}

async function replayProcessing(supabase: ServiceClient, input: OpsInput, operator: Operator) {
  const existing = await existingOperation(supabase, input);
  if (existing) return { ok: true, idempotent: true, event: existing, ...(existing.payload || {}) };

  const target = await loadReplayMessages(supabase, input);
  const operationId = crypto.randomUUID();
  const messageIds = target.messages.map((message) => message.id);
  const activeKeys = await activeJobKeys(supabase, messageIds, input.jobTypes);
  const inputVersion = operationInputVersion("replay", operationId);
  const rows = [];
  let skippedActive = 0;

  for (const message of target.messages) {
    for (const jobType of input.jobTypes) {
      const key = jobKey(message.id, jobType);
      if (activeKeys.has(key)) {
        skippedActive += 1;
        continue;
      }
      rows.push({
        message_id: message.id,
        job_type: jobType,
        status: "queued",
        priority: jobType === "normalize" ? 40 : 50,
        attempt_count: 0,
        max_attempts: 3,
        available_at: new Date().toISOString(),
        input_version: inputVersion,
        metadata: {
          processor_version: PROCESSOR_VERSION,
          replay_source: input.replaySource,
          operational_event_id: operationId,
          replay_reason: operationReason(input),
          replay_failure_category: input.failureCategory,
          replay_selector: target.selector,
        },
      });
      activeKeys.add(key);
    }
  }

  const newJobIds = await insertJobs(supabase, rows);
  await insertOperationalEvent(supabase, {
    id: operationId,
    eventType: "processing_replay",
    mailboxId: target.mailboxId || input.mailboxId,
    syncRunId: input.syncRunId,
    messageIds,
    newJobIds,
    jobTypes: input.jobTypes,
    input,
    operator,
    payload: {
      selector: target.selector,
      messages_selected: messageIds.length,
      new_jobs_enqueued: newJobIds.length,
      skipped_due_to_active_jobs: skippedActive,
      input_version: inputVersion,
      sample_limited: target.sampleLimited,
    },
  });

  return {
    ok: true,
    event_id: operationId,
    selector: target.selector,
    messages_selected: messageIds.length,
    new_jobs_enqueued: newJobIds.length,
    skipped_due_to_active_jobs: skippedActive,
    sample_limited: target.sampleLimited,
    new_job_ids: newJobIds,
  };
}

async function loadReplayMessages(supabase: ServiceClient, input: OpsInput) {
  if (input.messageId) {
    const { data, error } = await supabase
      .from("email_messages")
      .select("id, mailbox_id")
      .eq("id", input.messageId)
      .eq("sync_status", "active")
      .maybeSingle();
    if (error) throw new OpsError("replay_message_lookup_failed", { phase: "message_lookup" });
    if (!data?.id) throw new OpsError("message_not_found", { status: 404, phase: "message_lookup" });
    return { messages: [{ id: String(data.id) }], mailboxId: String(data.mailbox_id), selector: "message", sampleLimited: false };
  }

  let mailboxId = input.mailboxId;
  let selector = "mailbox_range";
  let query = supabase
    .from("email_messages")
    .select("id, mailbox_id")
    .eq("sync_status", "active")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(MAX_OPERATION_MESSAGES);

  if (input.syncRunId) {
    const { data: run, error: runError } = await supabase
      .from("email_sync_runs")
      .select("id, mailbox_id, folder_id, started_at, completed_at")
      .eq("id", input.syncRunId)
      .maybeSingle();
    if (runError) throw new OpsError("sync_run_lookup_failed", { phase: "sync_run_lookup" });
    if (!run?.id) throw new OpsError("sync_run_not_found", { status: 404, phase: "sync_run_lookup" });
    mailboxId = String(run.mailbox_id);
    selector = "sync_run_window";
    query = query.eq("mailbox_id", mailboxId).gte("last_seen_at", run.started_at);
    if (run.completed_at) query = query.lte("last_seen_at", run.completed_at);
  } else {
    if (!mailboxId) throw new OpsError("replay_selector_required", { status: 400, phase: "input" });
    query = query.eq("mailbox_id", mailboxId);
    if (input.startDate) query = query.gte("received_at", input.startDate);
    if (input.endDate) query = query.lte("received_at", input.endDate);
  }

  const { data, error } = await query;
  if (error) throw new OpsError("replay_message_lookup_failed", { phase: "message_lookup" });
  const messages = (data || []).map((row: { id: string }) => ({ id: row.id }));
  return { messages, mailboxId, selector, sampleLimited: messages.length >= MAX_OPERATION_MESSAGES };
}

async function resumeSyncReplay(supabase: ServiceClient, req: Request, input: OpsInput, operator: Operator) {
  const existing = await existingOperation(supabase, input);
  if (existing) return { ok: true, idempotent: true, event: existing, ...(existing.payload || {}) };
  if (!input.mailboxId) throw new OpsError("mailbox_id_required", { status: 400, phase: "input" });

  const { data: state, error: stateError } = await supabase
    .from("email_sync_states")
    .select("id, mailbox_id, folder_id, status, delta_link, metadata, last_error_code, consecutive_error_count")
    .eq("mailbox_id", input.mailboxId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (stateError) throw new OpsError("sync_state_lookup_failed", { phase: "sync_state_lookup" });
  if (!state?.id) throw new OpsError("sync_state_not_found", { status: 404, phase: "sync_state_lookup" });

  const metadata = state.metadata && typeof state.metadata === "object" ? state.metadata as Record<string, unknown> : {};
  const hasContinuation = Boolean(metadata.continuation_link);
  const hasDelta = Boolean(state.delta_link);
  const resetRequired = state.status === "reset_required";
  const resumable = !resetRequired && (hasContinuation || hasDelta || state.status === "error");
  if (!resumable) {
    throw new OpsError(resetRequired ? "delta_reset_required" : "sync_not_resumable", {
      status: resetRequired ? 409 : 400,
      phase: "sync_replay_guard",
    });
  }

  const operationId = crypto.randomUUID();
  let syncResponse: Record<string, unknown> | null = null;
  let syncStatus = 202;
  if (input.execute) {
    const invokeResult = await invokeExistingSync(req, {
      mode: hasContinuation || hasDelta ? "incremental" : "initial_backfill",
      maxPages: input.maxPages,
      pageSize: input.pageSizeForSync,
    });
    syncStatus = invokeResult.status;
    syncResponse = invokeResult.body;
  }

  await insertOperationalEvent(supabase, {
    id: operationId,
    eventType: "sync_replay",
    mailboxId: input.mailboxId,
    jobTypes: [],
    input,
    operator,
    payload: {
      sync_state_id: state.id,
      sync_state_status: state.status,
      has_saved_continuation: hasContinuation,
      has_delta_checkpoint: hasDelta,
      previous_error_code: state.last_error_code,
      previous_consecutive_failures: state.consecutive_error_count,
      execute: input.execute,
      invoked_existing_sync: input.execute,
      sync_response_status: syncStatus,
      sync_response: syncResponse,
    },
  });

  return {
    ok: syncStatus >= 200 && syncStatus < 300,
    event_id: operationId,
    sync_state_id: state.id,
    resumable: true,
    has_saved_continuation: hasContinuation,
    has_delta_checkpoint: hasDelta,
    invoked_existing_sync: input.execute,
    sync_response_status: syncStatus,
    sync_response: syncResponse,
  };
}

async function invokeExistingSync(req: Request, body: { mode: string; maxPages: number; pageSize: number }) {
  const baseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getBearerToken(req)}`,
    "Content-Type": "application/json",
  };
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (anonKey) headers.apikey = anonKey;

  const response = await fetch(`${baseUrl}/functions/v1/microsoft-email-sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: body.mode,
      folder: "inbox",
      maxPages: body.maxPages,
      pageSize: body.pageSize,
    }),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "sync_response_parse_failed" }));
  return { status: response.status, body: payload as Record<string, unknown> };
}

function safeError(error: unknown) {
  if (error instanceof OpsError) return error;
  return new OpsError("unexpected_error");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  try {
    const supabase = serviceClient();
    const operator = await requireOperator(req, supabase);
    const input = await parseInput(req);

    if (input.mode === "mailbox_health") return json(req, 200, await mailboxHealth(supabase, input));
    if (input.mode === "sync_status") return json(req, 200, await syncStatus(supabase, input));
    if (input.mode === "processing_queue_status") return json(req, 200, await processingQueueStatus(supabase, input));
    if (input.mode === "matching_statistics") return json(req, 200, await matchingStatistics(supabase, input));
    if (input.mode === "requeue_failed_jobs") return json(req, 200, await requeueFailedJobs(supabase, input, operator));
    if (input.mode === "replay_processing") return json(req, 200, await replayProcessing(supabase, input, operator));
    if (input.mode === "resume_sync_replay") return json(req, 200, await resumeSyncReplay(supabase, req, input, operator));

    throw new OpsError("invalid_mode", { status: 400, phase: "input" });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-email-ops] failed", {
      phase: safe.phase,
      error: safe.code,
    });
    return json(req, safe.status, { ok: false, error: safe.code });
  }
});
