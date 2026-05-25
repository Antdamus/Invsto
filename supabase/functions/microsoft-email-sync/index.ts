import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_SCOPES = "offline_access Mail.Read User.Read";
const ACTIVE_CONNECTION_STATUSES = ["connected", "error", "reconnect_required"];
const DURABLE_SYNC_MODES = ["initial_backfill", "incremental", "manual_resync"] as const;
const MESSAGE_SELECT = [
  "id",
  "createdDateTime",
  "lastModifiedDateTime",
  "changeKey",
  "categories",
  "receivedDateTime",
  "sentDateTime",
  "hasAttachments",
  "internetMessageId",
  "subject",
  "bodyPreview",
  "importance",
  "parentFolderId",
  "conversationId",
  "conversationIndex",
  "isRead",
  "isDraft",
  "webLink",
  "inferenceClassification",
  "body",
  "sender",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
].join(",");
const PREVIEW_MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "receivedDateTime",
  "sentDateTime",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bodyPreview",
  "hasAttachments",
  "importance",
  "parentFolderId",
  "categories",
].join(",");
const PREVIEW_DEFAULT_LIMIT = 25;
const PREVIEW_MAX_LIMIT = 100;
const PREVIEW_MAX_DAYS_BACK = 30;
const MAX_IMPORT_BATCH = PREVIEW_MAX_LIMIT;
const MAX_PROCESS_BATCH = 25;
const MAX_CLASSIFICATION_BATCH = 10;
const MAX_QUEUED_PROCESSING_JOBS = 100;
const MAX_RUNNING_PROCESSING_JOBS = 25;
const IMPORT_APPROVAL_CONFIRMATION = "IMPORT_PREVIEW_APPROVED";
const IMPORT_PROCESSOR_VERSION = "v1";
const PROCESS_IMPORTED_DEFAULT_BATCH_SIZE = 10;
const PROCESS_IMPORTED_MAX_BATCH_SIZE = MAX_PROCESS_BATCH;
const PROCESS_IMPORTED_JOB_TYPES = ["normalize", "match_order"] as const;
const PROCESS_IMPORTED_LOCKED_BY = "microsoft-email-sync:process_imported";
const PIPELINE_VISIBILITY_SCAN_LIMIT = 2000;
const PIPELINE_VISIBILITY_SCAN_PAGE_SIZE = 500;
const CLASSIFY_IMPORTED_DEFAULT_BATCH_SIZE = 5;
const CLASSIFY_IMPORTED_MAX_BATCH_SIZE = MAX_CLASSIFICATION_BATCH;
const NORMALIZED_TEXT_LIMIT = 200000;

type ServiceClient = ReturnType<typeof createClient>;
type DurableSyncMode = typeof DURABLE_SYNC_MODES[number];
type BucketMode = "ebay_only" | "all";

type MailboxConnection = {
  id: string;
  status: string;
  live_sync_enabled?: boolean | null;
};

type MailboxSecret = {
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  refresh_token_key_version: string;
};

type EmailMailbox = {
  id: string;
  microsoft_connection_id: string;
};

type EmailFolder = {
  id: string;
  provider_folder_id: string;
};

type EmailSyncState = {
  id: string;
  delta_link: string | null;
  consecutive_error_count: number | null;
  metadata: Record<string, unknown> | null;
};

type TokenRefreshResult = {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
};

type SyncInput = {
  mode: DurableSyncMode;
  folder: "inbox";
  maxPages: number;
  pageSize: number;
};

type PreviewInput = {
  mode: "sync_preview";
  folder: "inbox";
  limit: number;
  daysBack: number | null;
  bucketMode: BucketMode;
};

type ImportApprovedInput = {
  mode: "sync_import_approved";
  folder: "inbox";
  source: "preview";
  importBucket: EbayBucket;
  providerMessageIds: string[];
  limit: number;
  daysBack: number | null;
  bucketMode: BucketMode;
  confirmImport: string | null;
};

type ProcessImportedInput = {
  mode: "process_imported";
  folder: "inbox";
  batchSize: number;
};

type ClassifyImportedInput = {
  mode: "classify_imported";
  folder: "inbox";
  batchSize: number;
};

type RunLiveRefreshInput = {
  mode: "run_live_refresh";
  folder: "inbox";
  limit: number;
  daysBack: number | null;
  bucketMode: BucketMode;
  processBatchSize: number;
  classifyBatchSize: number;
};

type PipelineDiagnosticsInput = {
  mode: "pipeline_diagnostics";
  folder: "inbox";
};

type RolloutStatusInput = {
  mode: "rollout_status";
  folder: "inbox";
};

type LiveSyncStatusInput = {
  mode: "live_sync_status";
  folder: "inbox";
};

type SetLiveSyncInput = {
  mode: "set_live_sync";
  folder: "inbox";
  enabled: boolean;
};

type RequestInput =
  | SyncInput
  | PreviewInput
  | ImportApprovedInput
  | ProcessImportedInput
  | ClassifyImportedInput
  | RunLiveRefreshInput
  | PipelineDiagnosticsInput
  | RolloutStatusInput
  | LiveSyncStatusInput
  | SetLiveSyncInput;

type SyncCounters = {
  graph_request_count: number;
  pages_fetched: number;
  messages_seen: number;
  messages_inserted: number;
  messages_updated: number;
  messages_deleted: number;
  attachments_seen: number;
  jobs_enqueued: number;
};

type GraphRecipient = {
  emailAddress?: {
    name?: string | null;
    address?: string | null;
  } | null;
};

type GraphMessage = {
  id?: string;
  "@odata.etag"?: string;
  "@removed"?: { reason?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  changeKey?: string;
  categories?: string[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  internetMessageId?: string;
  subject?: string | null;
  bodyPreview?: string | null;
  importance?: string | null;
  parentFolderId?: string | null;
  conversationId?: string | null;
  conversationIndex?: string | null;
  isRead?: boolean;
  isDraft?: boolean;
  webLink?: string | null;
  inferenceClassification?: string | null;
  body?: {
    contentType?: string | null;
    content?: string | null;
  } | null;
  sender?: GraphRecipient | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
};

type EbayBucket = "likely_ebay" | "maybe_ebay" | "not_ebay";

type PreviewBucketResult = {
  bucket: EbayBucket;
  score: number;
  reason_codes: string[];
};

type PreviewMessageRow = {
  provider_message_id: string | null;
  provider_immutable_id: string | null;
  internet_message_id: string | null;
  conversation_id: string | null;
  received_at: string | null;
  sent_at: string | null;
  from_email: string | null;
  from_name: string | null;
  sender_email: string | null;
  sender_name: string | null;
  subject: string | null;
  body_preview: string | null;
  has_attachments: boolean;
  importance: string | null;
  parent_folder_id: string | null;
  categories: string[];
  bucket: EbayBucket;
  score: number;
  reason_codes: string[];
  already_imported: boolean;
  existing_message_id: string | null;
};

type ProcessImportedJobType = typeof PROCESS_IMPORTED_JOB_TYPES[number];

type ImportedEmailBody = {
  body_text: string | null;
  body_html: string | null;
  normalized_text: string | null;
  normalized_text_sha256: string | null;
  normalization_version: string | null;
};

type ImportedEmailMessage = {
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

type ImportedEmailRecipient = {
  recipient_type: string;
  display_name: string | null;
  email: string | null;
  email_normalized: string | null;
};

type ImportedProcessingJob = {
  id: string;
  message_id: string;
  job_type: ProcessImportedJobType;
  status: string;
  attempt_count: number | null;
  max_attempts: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

type ImportedIdentifiers = {
  orderNumbers: string[];
  itemNumbers: string[];
  transactionIds: string[];
  labels: string[];
  labelValues: string[];
  returnIds: string[];
  trackingNumbers: string[];
  titlePhrases: string[];
  buyerUsernames: string[];
  buyerEmails: string[];
};

type ImportedLinkCandidate = {
  message_id: string;
  link_type: "ebay_order" | "ebay_order_line" | "inventory_item" | "sale" | "customer_identity";
  ebay_order_id?: string | null;
  ebay_order_line_id?: string | null;
  item_id?: string | null;
  sale_id?: string | null;
  matched_value: string;
  match_method: string;
  confidence: number;
  status: "suggested" | "confirmed";
  metadata: Record<string, unknown>;
};

type ProcessImportedCounters = {
  queued_count: number;
  processed_count: number;
  skipped_count: number;
  failed_count: number;
  already_processed_count: number;
  currently_processing_count: number;
  permanently_failed_count: number;
  jobs_enqueued: number;
  jobs_processed: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_skipped: number;
  links_created: number;
  links_updated: number;
};

type ClassifyImportedCounters = {
  classified_count: number;
  skipped_count: number;
  failed_count: number;
  already_classified_count: number;
  currently_classifying_count: number;
  permanently_failed_count: number;
  processing_incomplete_count: number;
  processing_failed_count: number;
  jobs_enqueued: number;
  jobs_processed: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_skipped: number;
};

class SyncError extends Error {
  code: string;
  status: number;
  phase: string;
  connectionId?: string;
  mailboxId?: string;
  folderId?: string;
  syncRunId?: string;
  microsoftStatus?: number;
  microsoftError?: string;

  constructor(
    code: string,
    options: {
      status?: number;
      phase?: string;
      connectionId?: string;
      mailboxId?: string;
      folderId?: string;
      syncRunId?: string;
      microsoftStatus?: number;
      microsoftError?: string;
    } = {},
  ) {
    super(code);
    this.name = "SyncError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "sync";
    this.connectionId = options.connectionId;
    this.mailboxId = options.mailboxId;
    this.folderId = options.folderId;
    this.syncRunId = options.syncRunId;
    this.microsoftStatus = options.microsoftStatus;
    this.microsoftError = options.microsoftError;
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
  if (!value) throw new SyncError("configuration_error", { phase: "configuration" });
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

function envFlag(name: string) {
  return String(Deno.env.get(name) || "").trim().toLowerCase() === "true";
}

function rolloutControls() {
  return {
    imports_enabled: !envFlag("EMAIL_TRIAGE_DISABLE_IMPORTS"),
    processing_enabled: !envFlag("EMAIL_TRIAGE_DISABLE_PROCESSING"),
    classification_enabled: !envFlag("EMAIL_TRIAGE_DISABLE_CLASSIFICATION"),
  };
}

function rolloutCaps() {
  return {
    max_import_batch: MAX_IMPORT_BATCH,
    max_process_batch: MAX_PROCESS_BATCH,
    max_classification_batch: MAX_CLASSIFICATION_BATCH,
  };
}

function rolloutQueueLimits() {
  return {
    max_queued_processing_jobs: MAX_QUEUED_PROCESSING_JOBS,
    max_running_processing_jobs: MAX_RUNNING_PROCESSING_JOBS,
  };
}

function clampBatchSize(value: unknown, fallback: number, maximum: number) {
  const raw = Number(value);
  return Math.min(
    Math.max(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback, 1),
    maximum,
  );
}

async function parseInput(req: Request): Promise<RequestInput> {
  const body = await req.json().catch(() => ({}));
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  const folder = String(body?.folder || "inbox").toLowerCase();
  if (folder !== "inbox") {
    throw new SyncError("missing_folder", { status: 400, phase: "input" });
  }

  if (requestedMode === "sync_preview") {
    const rawLimit = Number(body?.limit);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : PREVIEW_DEFAULT_LIMIT, 1), PREVIEW_MAX_LIMIT);
    const rawDaysBack = body?.daysBack === null || body?.daysBack === undefined || body?.daysBack === ""
      ? null
      : Number(body.daysBack);
    const daysBack = rawDaysBack === null ? null : Math.min(Math.max(Number.isFinite(rawDaysBack) && rawDaysBack > 0 ? Math.floor(rawDaysBack) : 1, 1), PREVIEW_MAX_DAYS_BACK);
    const bucketMode = String(body?.bucketMode || "ebay_only") === "all" ? "all" : "ebay_only";
    return { mode: "sync_preview", folder: "inbox", limit, daysBack, bucketMode };
  }

  if (requestedMode === "sync_import_approved") {
    const limit = clampBatchSize(body?.limit, PREVIEW_DEFAULT_LIMIT, MAX_IMPORT_BATCH);
    const rawDaysBack = body?.daysBack === null || body?.daysBack === undefined || body?.daysBack === ""
      ? null
      : Number(body.daysBack);
    const daysBack = rawDaysBack === null ? null : Math.min(Math.max(Number.isFinite(rawDaysBack) && rawDaysBack > 0 ? Math.floor(rawDaysBack) : 1, 1), PREVIEW_MAX_DAYS_BACK);
    const bucketMode = String(body?.bucketMode || "ebay_only") === "all" ? "all" : "ebay_only";
    const importBucket = String(body?.importBucket || "likely_ebay") as EbayBucket;
    if (!["likely_ebay", "maybe_ebay", "not_ebay"].includes(importBucket)) {
      throw new SyncError("invalid_import_bucket", { status: 400, phase: "input" });
    }
    const providerMessageIds = Array.isArray(body?.providerMessageIds)
      ? [...new Set(body.providerMessageIds.map((value: unknown) => graphText(value)).filter(Boolean) as string[])].slice(0, MAX_IMPORT_BATCH)
      : [];
    const source = String(body?.source || "preview");
    if (source !== "preview") throw new SyncError("invalid_import_source", { status: 400, phase: "input" });
    return {
      mode: "sync_import_approved",
      folder: "inbox",
      source: "preview",
      importBucket,
      providerMessageIds,
      limit,
      daysBack,
      bucketMode,
      confirmImport: graphText(body?.confirmImport),
    };
  }

  if (requestedMode === "process_imported") {
    const batchSize = clampBatchSize(body?.batchSize ?? body?.limit, PROCESS_IMPORTED_DEFAULT_BATCH_SIZE, MAX_PROCESS_BATCH);
    return { mode: "process_imported", folder: "inbox", batchSize };
  }

  if (requestedMode === "classify_imported") {
    const batchSize = clampBatchSize(body?.batchSize ?? body?.limit, CLASSIFY_IMPORTED_DEFAULT_BATCH_SIZE, MAX_CLASSIFICATION_BATCH);
    return { mode: "classify_imported", folder: "inbox", batchSize };
  }

  if (requestedMode === "run_live_refresh") {
    const limit = clampBatchSize(body?.limit, PREVIEW_DEFAULT_LIMIT, MAX_IMPORT_BATCH);
    const rawDaysBack = body?.daysBack === null || body?.daysBack === undefined || body?.daysBack === ""
      ? null
      : Number(body.daysBack);
    const daysBack = rawDaysBack === null ? null : Math.min(Math.max(Number.isFinite(rawDaysBack) && rawDaysBack > 0 ? Math.floor(rawDaysBack) : 1, 1), PREVIEW_MAX_DAYS_BACK);
    const bucketMode = String(body?.bucketMode || "ebay_only") === "all" ? "all" : "ebay_only";
    const processBatchSize = clampBatchSize(body?.processBatchSize ?? body?.batchSize, PROCESS_IMPORTED_DEFAULT_BATCH_SIZE, PROCESS_IMPORTED_MAX_BATCH_SIZE);
    const classifyBatchSize = clampBatchSize(body?.classifyBatchSize ?? body?.batchSize, CLASSIFY_IMPORTED_DEFAULT_BATCH_SIZE, CLASSIFY_IMPORTED_MAX_BATCH_SIZE);
    return { mode: "run_live_refresh", folder: "inbox", limit, daysBack, bucketMode, processBatchSize, classifyBatchSize };
  }

  if (requestedMode === "pipeline_diagnostics") {
    return { mode: "pipeline_diagnostics", folder: "inbox" };
  }

  if (requestedMode === "rollout_status") {
    return { mode: "rollout_status", folder: "inbox" };
  }

  if (requestedMode === "live_sync_status") {
    return { mode: "live_sync_status", folder: "inbox" };
  }

  if (requestedMode === "set_live_sync") {
    if (typeof body?.enabled !== "boolean") {
      throw new SyncError("invalid_live_sync_enabled", { status: 400, phase: "input" });
    }
    return { mode: "set_live_sync", folder: "inbox", enabled: body.enabled };
  }

  const mode = DURABLE_SYNC_MODES.includes(requestedMode as DurableSyncMode) ? requestedMode as DurableSyncMode : "initial_backfill";
  const maxPages = Math.min(Math.max(Number(body?.maxPages) || 1, 1), 5);
  const pageSize = Math.min(Math.max(Number(body?.pageSize) || 25, 1), 50);
  return { mode, folder: "inbox", maxPages, pageSize };
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function tokenCryptoKey(usages: KeyUsage[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requiredEnv("MICROSOFT_TOKEN_ENCRYPTION_KEY")));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

async function decryptRefreshToken(secret: MailboxSecret) {
  const key = await tokenCryptoKey(["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(secret.refresh_token_iv) },
    key,
    decodeBase64(secret.refresh_token_ciphertext),
  );
  return new TextDecoder().decode(plain);
}

function tokenKeyVersion() {
  return Deno.env.get("MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION")?.trim() || "v1";
}

async function encryptRefreshToken(refreshToken: string) {
  const key = await tokenCryptoKey(["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(refreshToken));
  return {
    ciphertext: base64(new Uint8Array(cipher)),
    iv: base64(iv),
    keyVersion: tokenKeyVersion(),
  };
}

function accessTokenExpiry(expiresIn?: number) {
  if (!expiresIn || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function isoAfterSeconds(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSubject(value?: string | null) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function graphText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function graphDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function continuationLink(metadata: Record<string, unknown> | null | undefined) {
  const value = metadata?.continuation_link;
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

function withoutContinuation(metadata: Record<string, unknown> | null | undefined) {
  const next = { ...(metadata || {}) };
  delete next.partial_sync;
  delete next.continuation_link;
  delete next.continuation_saved_at;
  delete next.pages_fetched_before_pause;
  delete next.more_pages_available;
  delete next.delta_checkpoint_saved;
  return next;
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function person(recipient?: GraphRecipient | null) {
  const email = recipient?.emailAddress;
  return {
    name: graphText(email?.name),
    address: graphText(email?.address),
  };
}

async function updateConnectionHealth(supabase: ServiceClient, connectionId: string, values: Record<string, unknown>) {
  const { error } = await supabase
    .from("microsoft_mailbox_connections")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", connectionId);

  if (error) {
    console.error("[microsoft-email-sync] connection health update failed", {
      phase: "connection_health",
      connectionId,
    });
  }
}

async function markConnectionFailure(
  supabase: ServiceClient,
  connectionId: string,
  status: "error" | "reconnect_required",
  code: string,
) {
  await updateConnectionHealth(supabase, connectionId, {
    status,
    last_error_code: code,
    last_error_at: new Date().toISOString(),
  });
}

async function loadModel(supabase: ServiceClient) {
  const { data: mailboxes, error: mailboxError } = await supabase
    .from("email_mailboxes")
    .select("id, microsoft_connection_id")
    .eq("provider", "microsoft")
    .eq("status", "active")
    .eq("sync_enabled", true)
    .limit(2);

  if (mailboxError) throw new SyncError("bootstrap_required", { phase: "mailbox_lookup", status: 500 });
  if (!mailboxes?.length) throw new SyncError("bootstrap_required", { phase: "mailbox_lookup", status: 400 });
  if (mailboxes.length > 1) throw new SyncError("multiple_active_mailboxes", { phase: "mailbox_lookup", status: 409 });

  const mailbox = mailboxes[0] as EmailMailbox;
  if (!mailbox.microsoft_connection_id) throw new SyncError("bootstrap_required", { phase: "mailbox_lookup", mailboxId: mailbox.id });

  const { data: connection, error: connectionError } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id, status")
    .eq("id", mailbox.microsoft_connection_id)
    .maybeSingle();

  if (connectionError || !connection) {
    throw new SyncError("mailbox_not_connected", { phase: "connection_lookup", mailboxId: mailbox.id, status: 404 });
  }
  if (!ACTIVE_CONNECTION_STATUSES.includes(String(connection.status))) {
    throw new SyncError("mailbox_not_connected", {
      phase: "connection_lookup",
      mailboxId: mailbox.id,
      connectionId: mailbox.microsoft_connection_id,
      status: 401,
    });
  }

  const { data: folder, error: folderError } = await supabase
    .from("email_folders")
    .select("id, provider_folder_id")
    .eq("mailbox_id", mailbox.id)
    .eq("well_known_name", "inbox")
    .eq("is_sync_enabled", true)
    .maybeSingle();

  if (folderError) throw new SyncError("missing_folder", { phase: "folder_lookup", mailboxId: mailbox.id });
  if (!folder?.id || !folder.provider_folder_id) {
    throw new SyncError("bootstrap_required", { phase: "folder_lookup", mailboxId: mailbox.id, status: 400 });
  }

  const { data: syncState, error: syncStateError } = await supabase
    .from("email_sync_states")
    .select("id, delta_link, consecutive_error_count, metadata")
    .eq("mailbox_id", mailbox.id)
    .eq("folder_id", folder.id)
    .eq("sync_scope", "folder_messages")
    .maybeSingle();

  if (syncStateError) throw new SyncError("missing_sync_state", { phase: "sync_state_lookup", mailboxId: mailbox.id, folderId: folder.id });
  if (!syncState?.id) {
    throw new SyncError("bootstrap_required", { phase: "sync_state_lookup", mailboxId: mailbox.id, folderId: folder.id, status: 400 });
  }

  const { data: secret, error: secretError } = await supabase
    .from("microsoft_mailbox_connection_secrets")
    .select("refresh_token_ciphertext, refresh_token_iv, refresh_token_key_version")
    .eq("connection_id", mailbox.microsoft_connection_id)
    .maybeSingle();

  if (secretError) {
    throw new SyncError("missing_connection_secret", {
      phase: "secret_lookup",
      connectionId: mailbox.microsoft_connection_id,
      mailboxId: mailbox.id,
      status: 500,
    });
  }
  if (!secret) {
    await markConnectionFailure(supabase, mailbox.microsoft_connection_id, "reconnect_required", "missing_connection_secret");
    throw new SyncError("missing_connection_secret", {
      phase: "secret_lookup",
      connectionId: mailbox.microsoft_connection_id,
      mailboxId: mailbox.id,
      status: 401,
    });
  }

  return {
    mailbox,
    connection: connection as MailboxConnection,
    folder: folder as EmailFolder,
    syncState: syncState as EmailSyncState,
    secret: secret as MailboxSecret,
  };
}

async function loadProcessingModel(supabase: ServiceClient) {
  const { data: mailboxes, error: mailboxError } = await supabase
    .from("email_mailboxes")
    .select("id, microsoft_connection_id")
    .eq("provider", "microsoft")
    .eq("status", "active")
    .limit(2);

  if (mailboxError) throw new SyncError("bootstrap_required", { phase: "mailbox_lookup", status: 500 });
  if (!mailboxes?.length) throw new SyncError("bootstrap_required", { phase: "mailbox_lookup", status: 400 });
  if (mailboxes.length > 1) throw new SyncError("multiple_active_mailboxes", { phase: "mailbox_lookup", status: 409 });

  const mailbox = mailboxes[0] as { id: string; microsoft_connection_id?: string | null };
  const { data: folder, error: folderError } = await supabase
    .from("email_folders")
    .select("id")
    .eq("mailbox_id", mailbox.id)
    .eq("well_known_name", "inbox")
    .maybeSingle();

  if (folderError) throw new SyncError("missing_folder", { phase: "folder_lookup", mailboxId: mailbox.id });
  if (!folder?.id) throw new SyncError("bootstrap_required", { phase: "folder_lookup", mailboxId: mailbox.id, status: 400 });

  return {
    mailbox,
    folder: folder as { id: string },
  };
}

async function loadLiveSyncModel(supabase: ServiceClient) {
  const processingModel = await loadProcessingModel(supabase);
  const connectionId = processingModel.mailbox.microsoft_connection_id;
  if (!connectionId) {
    throw new SyncError("mailbox_not_connected", {
      phase: "live_sync_connection_lookup",
      mailboxId: processingModel.mailbox.id,
      status: 404,
    });
  }

  const { data: connection, error: connectionError } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id, status, live_sync_enabled")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError || !connection) {
    throw new SyncError("mailbox_not_connected", {
      phase: "live_sync_connection_lookup",
      mailboxId: processingModel.mailbox.id,
      status: 404,
    });
  }

  return {
    ...processingModel,
    connection: connection as MailboxConnection,
  };
}

async function exchangeRefreshToken(refreshToken: string, connectionId: string): Promise<TokenRefreshResult> {
  const authorityHost = Deno.env.get("MICROSOFT_AUTHORITY_HOST")?.trim() || DEFAULT_AUTHORITY_HOST;
  const tenantId = requiredEnv("MICROSOFT_TENANT_ID");
  const tokenUrl = `${authorityHost.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", requiredEnv("MICROSOFT_CLIENT_ID"));
  body.set("client_secret", requiredEnv("MICROSOFT_CLIENT_SECRET"));
  body.set("refresh_token", refreshToken);
  body.set("scope", Deno.env.get("MICROSOFT_GRAPH_SCOPES")?.trim() || DEFAULT_SCOPES);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new SyncError("token_refresh_failed", {
      phase: "token_refresh",
      connectionId,
      status: 401,
      microsoftStatus: response.status,
      microsoftError: typeof payload?.error === "string" ? payload.error : undefined,
    });
  }

  const expiresIn = Number(payload.expires_in);
  const refreshTokenExpiresIn = Number(payload.refresh_token_expires_in);
  return {
    accessToken: String(payload.access_token),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined,
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : undefined,
    refreshTokenExpiresIn: Number.isFinite(refreshTokenExpiresIn) && refreshTokenExpiresIn > 0 ? refreshTokenExpiresIn : undefined,
  };
}

async function rotateRefreshToken(
  supabase: ServiceClient,
  connectionId: string,
  refreshToken: string,
  refreshTokenExpiresIn?: number,
) {
  const encrypted = await encryptRefreshToken(refreshToken);
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("microsoft_mailbox_connection_secrets")
    .update({
      refresh_token_ciphertext: encrypted.ciphertext,
      refresh_token_iv: encrypted.iv,
      refresh_token_key_version: encrypted.keyVersion,
      refresh_token_last_rotated_at: nowIso,
      refresh_token_expires_at: isoAfterSeconds(refreshTokenExpiresIn),
      updated_at: nowIso,
    })
    .eq("connection_id", connectionId);

  if (error) throw new SyncError("token_refresh_failed", { phase: "token_rotation", connectionId, status: 401 });
}

function initialDeltaUrl(folderProviderId: string, pageSize: number) {
  const graphBaseUrl = Deno.env.get("MICROSOFT_GRAPH_BASE_URL")?.trim() || DEFAULT_GRAPH_BASE_URL;
  const url = new URL(`${graphBaseUrl.replace(/\/+$/, "")}/me/mailFolders/${encodeURIComponent(folderProviderId)}/messages/delta`);
  url.searchParams.set("$top", String(pageSize));
  url.searchParams.set("$select", MESSAGE_SELECT);
  return url.toString();
}

async function fetchDeltaPage(url: string, accessToken: string, model: { connectionId: string; mailboxId: string; folderId: string }) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const microsoftError = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    const expired = response.status === 410 || /deltatoken|syncstate/i.test(String(microsoftError || ""));
    throw new SyncError(expired ? "graph_delta_expired" : "graph_delta_failed", {
      phase: "graph_delta",
      connectionId: model.connectionId,
      mailboxId: model.mailboxId,
      folderId: model.folderId,
      status: expired ? 409 : response.status >= 500 ? 502 : response.status,
      microsoftStatus: response.status,
      microsoftError,
    });
  }

  return payload as {
    value?: GraphMessage[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
  };
}

function previewMessagesUrl(folderProviderId: string, input: PreviewInput) {
  const graphBaseUrl = Deno.env.get("MICROSOFT_GRAPH_BASE_URL")?.trim() || DEFAULT_GRAPH_BASE_URL;
  const url = new URL(`${graphBaseUrl.replace(/\/+$/, "")}/me/mailFolders/${encodeURIComponent(folderProviderId)}/messages`);
  url.searchParams.set("$top", String(input.limit));
  url.searchParams.set("$select", PREVIEW_MESSAGE_SELECT);
  url.searchParams.set("$orderby", "receivedDateTime desc");
  if (input.daysBack !== null) {
    const since = new Date(Date.now() - input.daysBack * 24 * 60 * 60 * 1000).toISOString();
    url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  }
  return url.toString();
}

async function fetchPreviewMessages(url: string, accessToken: string, model: { connectionId: string; mailboxId: string; folderId: string }) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const microsoftError = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    throw new SyncError("graph_preview_failed", {
      phase: "graph_preview",
      connectionId: model.connectionId,
      mailboxId: model.mailboxId,
      folderId: model.folderId,
      status: response.status >= 500 ? 502 : response.status,
      microsoftStatus: response.status,
      microsoftError,
    });
  }

  return payload as { value?: GraphMessage[] };
}

function messageUrl(providerMessageId: string) {
  const graphBaseUrl = Deno.env.get("MICROSOFT_GRAPH_BASE_URL")?.trim() || DEFAULT_GRAPH_BASE_URL;
  const url = new URL(`${graphBaseUrl.replace(/\/+$/, "")}/me/messages/${encodeURIComponent(providerMessageId)}`);
  url.searchParams.set("$select", MESSAGE_SELECT);
  return url.toString();
}

async function fetchFullMessage(providerMessageId: string, accessToken: string, model: { connectionId: string; mailboxId: string; folderId: string }) {
  const response = await fetch(messageUrl(providerMessageId), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const microsoftError = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    throw new SyncError("graph_message_fetch_failed", {
      phase: "graph_message_fetch",
      connectionId: model.connectionId,
      mailboxId: model.mailboxId,
      folderId: model.folderId,
      status: response.status >= 500 ? 502 : response.status,
      microsoftStatus: response.status,
      microsoftError,
    });
  }

  return payload as GraphMessage;
}

function emailDomain(value?: string | null) {
  const email = normalizeEmail(value);
  const domain = email.includes("@") ? email.split("@").pop() : "";
  return domain || null;
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function bucketPreviewMessage(message: GraphMessage): PreviewBucketResult {
  const from = person(message.from);
  const sender = person(message.sender);
  const fromAddress = normalizeEmail(from.address);
  const senderAddress = normalizeEmail(sender.address);
  const fromDomain = emailDomain(fromAddress);
  const senderDomain = emailDomain(senderAddress);
  const displayText = `${from.name || ""} ${sender.name || ""}`.toLowerCase();
  const subject = String(message.subject || "");
  const bodyPreview = String(message.bodyPreview || "");
  const searchable = `${subject}\n${bodyPreview}`.toLowerCase();
  const reason_codes: string[] = [];
  let score = 0;

  const ebayDomains = [
    "ebay.com",
    "ebay.co.uk",
    "ebay.ca",
    "ebay.com.au",
    "ebay.de",
    "ebay.fr",
    "ebay.it",
    "ebay.es",
    "ebaystatic.com",
    "ebayinc.com",
  ];
  const domainIsEbay = (domain: string | null) => Boolean(domain && (ebayDomains.includes(domain) || domain.endsWith(".ebay.com")));

  if (domainIsEbay(fromDomain) || domainIsEbay(senderDomain)) {
    reason_codes.push("sender_domain_ebay");
    score += 45;
  }
  if (/\bebay\b/i.test(displayText)) {
    reason_codes.push("sender_display_name_ebay");
    score += 25;
  }
  if (hasAny(searchable, [/\bebay\b/, /\bmy ebay\b/, /\bebay account\b/, /\bon ebay\b/])) {
    reason_codes.push("text_contains_ebay");
    score += 20;
  }
  if (hasAny(searchable, [/\border\s*(?:number|#|id)\s*[:#-]?\s*\d{2,}[-\d]*/i, /\b\d{2}-\d{5}-\d{5}\b/])) {
    reason_codes.push("text_contains_order_number_pattern");
    score += 25;
  }
  if (hasAny(searchable, [/\breturn\s+(?:case|request|started|received|approved|closed)\b/i, /\bcase\s*(?:id|number|#)\b/i])) {
    reason_codes.push("text_contains_return_case_phrase");
    score += 25;
  }
  if (hasAny(searchable, [/\b(?:cancellation|cancelled|canceled|refund|refunded|shipping|shipped|delivered|tracking|label|payment|paid|order update|purchase|sold|item won)\b/i])) {
    reason_codes.push("text_contains_order_shipping_refund_phrase");
    score += 15;
  }
  if (hasAny(searchable, [/\b(?:buyer|seller)\s+(?:sent|message|responded|contacted)\b/i, /\bmessage from (?:a )?(?:buyer|seller)\b/i, /\brespond to (?:the )?(?:buyer|seller)\b/i])) {
    reason_codes.push("text_contains_marketplace_buyer_message_language");
    score += 20;
  }
  if (hasAny(searchable, [/[a-z0-9._%+-]+@[a-z0-9.-]*members\.ebay\.[a-z.]+/i, /@reply\.ebay\.com/i, /@members\.ebay\./i])) {
    reason_codes.push("text_contains_masked_ebay_email_pattern");
    score += 30;
  }
  if (hasAny(searchable, [/\bitem\s*(?:number|#|id)\s*[:#-]?\s*\d{6,}\b/i, /\btransaction\s*(?:id|number|#)\s*[:#-]?\s*[a-z0-9-]{6,}\b/i])) {
    reason_codes.push("text_contains_item_or_transaction_pattern");
    score += /\bebay\b/i.test(searchable) ? 25 : 10;
  }
  if (!reason_codes.length && hasAny(searchable, [/\b(?:marketplace|seller|buyer|listing|order|return|shipment|tracking)\b/i])) {
    reason_codes.push("text_contains_vague_marketplace_phrase");
    score += 10;
  }
  if (!domainIsEbay(fromDomain) && !domainIsEbay(senderDomain) && /^fwd?:|^fw:/i.test(subject) && /\bebay\b/i.test(searchable)) {
    reason_codes.push("forwarded_looking_ebay_content");
    score += 15;
  }

  score = Math.min(score, 100);
  const bucket: EbayBucket = score >= 60 ? "likely_ebay" : score >= 20 ? "maybe_ebay" : "not_ebay";
  if (!reason_codes.length) reason_codes.push("no_ebay_preview_signals");
  return { bucket, score, reason_codes };
}

function previewInputFrom(input: PreviewInput | ImportApprovedInput): PreviewInput {
  return {
    mode: "sync_preview",
    folder: input.folder,
    limit: input.limit,
    daysBack: input.daysBack,
    bucketMode: input.bucketMode,
  };
}

function buildPreviewRows(messages: GraphMessage[], existingMatches: Map<string, string>) {
  const bucketSummary: Record<EbayBucket, number> = { likely_ebay: 0, maybe_ebay: 0, not_ebay: 0 };
  const senderDomainSummary: Record<string, number> = {};
  let alreadyImportedCount = 0;

  const rows: PreviewMessageRow[] = messages.map((message) => {
    const from = person(message.from);
    const sender = person(message.sender);
    const bucket = bucketPreviewMessage(message);
    bucketSummary[bucket.bucket] += 1;
    const domain = emailDomain(from.address) || emailDomain(sender.address) || "unknown";
    senderDomainSummary[domain] = (senderDomainSummary[domain] || 0) + 1;
    const existingMessageId = (message.id && existingMatches.get(String(message.id))) ||
      (message.internetMessageId && existingMatches.get(String(message.internetMessageId))) ||
      null;
    const alreadyImported = Boolean(existingMessageId);
    if (alreadyImported) alreadyImportedCount += 1;

    return {
      provider_message_id: graphText(message.id),
      provider_immutable_id: graphText(message.id),
      internet_message_id: graphText(message.internetMessageId),
      conversation_id: graphText(message.conversationId),
      received_at: graphDate(message.receivedDateTime),
      sent_at: graphDate(message.sentDateTime),
      from_email: normalizeEmail(from.address) || null,
      from_name: from.name,
      sender_email: normalizeEmail(sender.address) || null,
      sender_name: sender.name,
      subject: graphText(message.subject),
      body_preview: graphText(message.bodyPreview),
      has_attachments: message.hasAttachments === true,
      importance: graphText(message.importance),
      parent_folder_id: graphText(message.parentFolderId),
      categories: Array.isArray(message.categories) ? message.categories : [],
      bucket: bucket.bucket,
      score: bucket.score,
      reason_codes: bucket.reason_codes,
      already_imported: alreadyImported,
      existing_message_id: existingMessageId,
    };
  });

  return { rows, bucketSummary, senderDomainSummary, alreadyImportedCount };
}

function incrementReason(summary: Record<string, number>, reason: string) {
  summary[reason] = (summary[reason] || 0) + 1;
}

async function loadExistingPreviewMatches(supabase: ServiceClient, mailboxId: string, messages: GraphMessage[]) {
  const providerIds = Array.from(new Set(messages.map((message) => graphText(message.id)).filter(Boolean) as string[]));
  const internetIds = Array.from(new Set(messages.map((message) => graphText(message.internetMessageId)).filter(Boolean) as string[]));
  const matches = new Map<string, string>();

  if (providerIds.length) {
    const { data, error } = await supabase
      .from("email_messages")
      .select("id, provider_message_id")
      .eq("mailbox_id", mailboxId)
      .in("provider_message_id", providerIds);
    if (error) throw new SyncError("preview_existing_lookup_failed", { phase: "preview_existing_lookup", mailboxId });
    for (const row of data || []) {
      if (row.provider_message_id && row.id) matches.set(String(row.provider_message_id), String(row.id));
    }

    const { data: immutableData, error: immutableError } = await supabase
      .from("email_messages")
      .select("id, provider_immutable_id")
      .eq("mailbox_id", mailboxId)
      .in("provider_immutable_id", providerIds);
    if (immutableError) throw new SyncError("preview_existing_lookup_failed", { phase: "preview_existing_lookup", mailboxId });
    for (const row of immutableData || []) {
      if (row.provider_immutable_id && row.id) matches.set(String(row.provider_immutable_id), String(row.id));
    }
  }

  if (internetIds.length) {
    const { data, error } = await supabase
      .from("email_messages")
      .select("id, internet_message_id")
      .eq("mailbox_id", mailboxId)
      .in("internet_message_id", internetIds);
    if (error) throw new SyncError("preview_existing_lookup_failed", { phase: "preview_existing_lookup", mailboxId });
    for (const row of data || []) {
      if (row.internet_message_id && row.id) matches.set(String(row.internet_message_id), String(row.id));
    }
  }

  return matches;
}

async function createSyncRun(
  supabase: ServiceClient,
  values: { mailboxId: string; folderId: string; syncStateId: string; mode: DurableSyncMode; startedBy: string },
) {
  const { data, error } = await supabase
    .from("email_sync_runs")
    .insert({
      mailbox_id: values.mailboxId,
      folder_id: values.folderId,
      sync_state_id: values.syncStateId,
      run_type: values.mode,
      status: "running",
      started_by: values.startedBy,
      trigger_source: "edge_function",
      metadata: { function: "microsoft-email-sync" },
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new SyncError("sync_run_update_failed", {
      phase: "sync_run_create",
      mailboxId: values.mailboxId,
      folderId: values.folderId,
    });
  }

  return String(data.id);
}

async function updateSyncRun(supabase: ServiceClient, runId: string, values: Record<string, unknown>) {
  const { error } = await supabase.from("email_sync_runs").update(values).eq("id", runId);
  if (error) {
    console.error("[microsoft-email-sync] sync run update failed", {
      phase: "sync_run_update",
      syncRunId: runId,
    });
  }
}

async function updateSyncState(supabase: ServiceClient, stateId: string, values: Record<string, unknown>) {
  const { error } = await supabase.from("email_sync_states").update(values).eq("id", stateId);
  if (error) throw new SyncError("sync_state_update_failed", { phase: "sync_state_update" });
}

async function insertImportOperationalEvent(
  supabase: ServiceClient,
  values: {
    mailboxId: string;
    messageIds: string[];
    initiatedBy: string;
    initiatedByEmail: string | null;
    payload: Record<string, unknown>;
  },
) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .insert({
      event_type: "sync_import_approved",
      mailbox_id: values.mailboxId,
      message_ids: values.messageIds,
      reason: "Approved preview import without classification, drafts, Outlook mutation, or sync checkpoint updates.",
      initiated_by: values.initiatedBy,
      initiated_by_email: values.initiatedByEmail,
      replay_source: "sync_import_approved",
      payload: values.payload,
    })
    .select("id, created_at")
    .single();

  if (error || !data?.id) {
    console.error("[microsoft-email-sync] import audit insert failed", {
      phase: "sync_import_approved_audit",
      mailbox_id: values.mailboxId,
    });
    return null;
  }

  return data as { id: string; created_at: string };
}

async function insertSetLiveSyncOperationalEvent(
  supabase: ServiceClient,
  values: {
    mailboxId: string;
    initiatedBy: string;
    initiatedByEmail: string | null;
    previousValue: boolean;
    currentValue: boolean;
  },
) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .insert({
      event_type: "set_live_sync",
      mailbox_id: values.mailboxId,
      reason: "Operator-controlled mailbox live sync eligibility toggle. No sync, import, processing, classification, Outlook mutation, or checkpoint update was triggered.",
      initiated_by: values.initiatedBy,
      initiated_by_email: values.initiatedByEmail,
      replay_source: "set_live_sync",
      payload: {
        mode: "set_live_sync",
        previous_value: values.previousValue,
        current_value: values.currentValue,
        safety: liveSyncSafety(),
      },
    })
    .select("id, created_at")
    .single();

  if (error || !data?.id) {
    console.error("[microsoft-email-sync] set_live_sync audit insert failed", {
      phase: "set_live_sync_audit",
      mailbox_id: values.mailboxId,
    });
    throw new SyncError("set_live_sync_event_failed", {
      phase: "set_live_sync_audit",
      mailboxId: values.mailboxId,
      status: 500,
    });
  }

  return data as { id: string; created_at: string };
}

async function insertRunLiveRefreshOperationalEvent(
  supabase: ServiceClient,
  values: {
    mailboxId: string;
    initiatedBy: string;
    initiatedByEmail: string | null;
    payload: Record<string, unknown>;
  },
) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .insert({
      event_type: "run_live_refresh",
      mailbox_id: values.mailboxId,
      reason: "Operator-triggered bounded live refresh orchestration. No Outlook mutation, sending, draft generation, polling, or checkpoint update is performed.",
      initiated_by: values.initiatedBy,
      initiated_by_email: values.initiatedByEmail,
      replay_source: "run_live_refresh",
      payload: values.payload,
    })
    .select("id, created_at")
    .single();

  if (error || !data?.id) {
    console.error("[microsoft-email-sync] run_live_refresh audit insert failed", {
      phase: "run_live_refresh_audit",
      mailbox_id: values.mailboxId,
    });
    throw new SyncError("run_live_refresh_event_failed", {
      phase: "run_live_refresh_audit",
      mailboxId: values.mailboxId,
      status: 500,
    });
  }

  return data as { id: string; created_at: string };
}

async function updateRunLiveRefreshOperationalEvent(
  supabase: ServiceClient,
  operationId: string,
  payload: Record<string, unknown>,
) {
  const { error } = await supabase
    .from("email_operational_events")
    .update({ payload })
    .eq("id", operationId);

  if (error) {
    console.error("[microsoft-email-sync] run_live_refresh audit update failed", {
      phase: "run_live_refresh_audit_update",
      operation_id: operationId,
    });
  }
}

async function findExistingMessage(supabase: ServiceClient, mailboxId: string, message: GraphMessage) {
  const { data, error } = await supabase
    .from("email_messages")
    .select("id, provider_message_id")
    .eq("mailbox_id", mailboxId)
    .eq("provider_message_id", message.id)
    .limit(1)
    .maybeSingle();

  if (error) throw new SyncError("message_upsert_failed", { phase: "message_lookup", mailboxId });
  if (data?.id) return data as { id: string; provider_message_id: string };

  const internetMessageId = graphText(message.internetMessageId);
  if (!internetMessageId) return null;

  const { data: internetMatch, error: internetError } = await supabase
    .from("email_messages")
    .select("id, provider_message_id")
    .eq("mailbox_id", mailboxId)
    .eq("internet_message_id", internetMessageId)
    .limit(1)
    .maybeSingle();

  if (internetError) throw new SyncError("message_upsert_failed", { phase: "message_lookup", mailboxId });
  return internetMatch as { id: string; provider_message_id: string } | null;
}

async function markMessageDeleted(supabase: ServiceClient, mailboxId: string, providerMessageId: string) {
  const { data, error } = await supabase
    .from("email_messages")
    .update({
      sync_status: "tombstone",
      deleted_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .eq("mailbox_id", mailboxId)
    .eq("provider_message_id", providerMessageId)
    .select("id")
    .maybeSingle();

  if (error) throw new SyncError("message_upsert_failed", { phase: "message_tombstone", mailboxId });
  return Boolean(data?.id);
}

async function upsertMessage(
  supabase: ServiceClient,
  mailboxId: string,
  folderId: string,
  message: GraphMessage,
) {
  if (!message.id) throw new SyncError("message_upsert_failed", { phase: "message_upsert", mailboxId, folderId });
  const existing = await findExistingMessage(supabase, mailboxId, message);
  const from = person(message.from);
  const sender = person(message.sender);
  const nowIso = new Date().toISOString();
  const values = {
    mailbox_id: mailboxId,
    folder_id: folderId,
    provider: "microsoft",
    provider_message_id: String(message.id),
    provider_immutable_id: String(message.id),
    internet_message_id: graphText(message.internetMessageId),
    conversation_id: graphText(message.conversationId),
    conversation_index: graphText(message.conversationIndex),
    subject: graphText(message.subject),
    subject_normalized: normalizeSubject(message.subject),
    from_name: from.name,
    from_email: normalizeEmail(from.address) || null,
    sender_name: sender.name,
    sender_email: normalizeEmail(sender.address) || null,
    reply_to_emails: (message.replyTo || []).map((item) => normalizeEmail(person(item).address)).filter(Boolean),
    received_at: graphDate(message.receivedDateTime),
    sent_at: graphDate(message.sentDateTime),
    created_date_time: graphDate(message.createdDateTime),
    last_modified_date_time: graphDate(message.lastModifiedDateTime),
    web_link: graphText(message.webLink),
    importance: graphText(message.importance),
    inference_classification: graphText(message.inferenceClassification),
    is_read: typeof message.isRead === "boolean" ? message.isRead : null,
    is_draft: typeof message.isDraft === "boolean" ? message.isDraft : null,
    has_attachments: message.hasAttachments === true,
    body_preview: graphText(message.bodyPreview),
    body_content_type: graphText(message.body?.contentType)?.toLowerCase(),
    graph_etag: graphText(message["@odata.etag"]),
    graph_change_key: graphText(message.changeKey),
    sync_status: "active",
    last_seen_at: nowIso,
    deleted_at: null,
    raw_graph_metadata: {
      parentFolderId: graphText(message.parentFolderId),
      categories: Array.isArray(message.categories) ? message.categories : [],
      graph_immutable_id_preference: true,
    },
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from("email_messages")
      .update(values)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error || !data?.id) throw new SyncError("message_upsert_failed", { phase: "message_update", mailboxId, folderId });
    return { messageId: String(data.id), inserted: false };
  }

  const { data, error } = await supabase
    .from("email_messages")
    .insert({ ...values, first_seen_at: nowIso })
    .select("id")
    .single();
  if (error || !data?.id) throw new SyncError("message_upsert_failed", { phase: "message_insert", mailboxId, folderId });
  return { messageId: String(data.id), inserted: true };
}

function recipientRows(messageId: string, message: GraphMessage) {
  const rows: Array<Record<string, unknown>> = [];
  const add = (type: string, recipients: GraphRecipient[] | undefined, startPosition = 0) => {
    (recipients || []).forEach((item, index) => {
      const parsed = person(item);
      const email = graphText(parsed.address);
      const normalized = normalizeEmail(email);
      if (!normalized) return;
      rows.push({
        message_id: messageId,
        recipient_type: type,
        display_name: parsed.name,
        email,
        email_normalized: normalized,
        position: startPosition + index,
      });
    });
  };

  add("from", message.from ? [message.from] : []);
  add("sender", message.sender ? [message.sender] : []);
  add("to", message.toRecipients);
  add("cc", message.ccRecipients);
  add("bcc", message.bccRecipients);
  add("reply_to", message.replyTo);
  return rows;
}

async function replaceRecipients(supabase: ServiceClient, messageId: string, message: GraphMessage) {
  const { error: deleteError } = await supabase.from("email_message_recipients").delete().eq("message_id", messageId);
  if (deleteError) throw new SyncError("recipient_upsert_failed", { phase: "recipient_delete" });

  const rows = recipientRows(messageId, message);
  if (!rows.length) return;

  const { error } = await supabase.from("email_message_recipients").insert(rows);
  if (error) throw new SyncError("recipient_upsert_failed", { phase: "recipient_insert" });
}

async function upsertBody(supabase: ServiceClient, messageId: string, message: GraphMessage) {
  const contentType = graphText(message.body?.contentType)?.toLowerCase();
  const content = typeof message.body?.content === "string" ? message.body.content : "";
  if (!contentType || !content) {
    const { error } = await supabase.from("email_message_bodies").upsert(
      {
        message_id: messageId,
        body_text: null,
        body_html: null,
        body_text_sha256: null,
        body_html_sha256: null,
        normalized_text: null,
        normalized_text_sha256: null,
        normalization_version: "v1",
        redaction_status: "body_omitted",
        metadata: { source: "microsoft_graph_delta" },
        stored_at: new Date().toISOString(),
      },
      { onConflict: "message_id" },
    );
    if (error) throw new SyncError("body_upsert_failed", { phase: "body_omitted" });
    return;
  }

  const bodyText = contentType === "html" ? null : content;
  const bodyHtml = contentType === "html" ? content : null;
  const normalizedText = contentType === "html" ? stripHtml(content) : content.replace(/\s+/g, " ").trim();
  const { error } = await supabase.from("email_message_bodies").upsert(
    {
      message_id: messageId,
      body_text: bodyText,
      body_html: bodyHtml,
      body_text_sha256: bodyText ? await sha256Hex(bodyText) : null,
      body_html_sha256: bodyHtml ? await sha256Hex(bodyHtml) : null,
      normalized_text: normalizedText || null,
      normalized_text_sha256: normalizedText ? await sha256Hex(normalizedText) : null,
      normalization_version: "v1",
      redaction_status: "unredacted",
      metadata: { source: "microsoft_graph_delta" },
      stored_at: new Date().toISOString(),
    },
    { onConflict: "message_id" },
  );

  if (error) throw new SyncError("body_upsert_failed", { phase: "body_upsert" });
}

async function processGraphMessage(
  supabase: ServiceClient,
  mailboxId: string,
  folderId: string,
  message: GraphMessage,
  counters: SyncCounters,
) {
  if (!message.id) return;
  counters.messages_seen += 1;

  if (message["@removed"]) {
    if (await markMessageDeleted(supabase, mailboxId, message.id)) counters.messages_deleted += 1;
    return;
  }

  const result = await upsertMessage(supabase, mailboxId, folderId, message);
  if (result.inserted) counters.messages_inserted += 1;
  else counters.messages_updated += 1;

  if (message.hasAttachments === true) counters.attachments_seen += 1;
  await replaceRecipients(supabase, result.messageId, message);
  await upsertBody(supabase, result.messageId, message);
}

function lowerTrim(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueLower(values: Array<string | null | undefined>) {
  return unique(values.map((value) => lowerTrim(value))).filter(Boolean);
}

function normalizeImportedText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, NORMALIZED_TEXT_LIMIT);
}

function importedIdentifiersSummary(identifiers: ImportedIdentifiers) {
  return {
    order_numbers: identifiers.orderNumbers.length,
    item_numbers: identifiers.itemNumbers.length,
    transaction_ids: identifiers.transactionIds.length,
    listing_labels: identifiers.labels.length,
    return_ids: identifiers.returnIds.length,
    tracking_numbers: identifiers.trackingNumbers.length,
    title_phrases: identifiers.titlePhrases.length,
    buyer_usernames: identifiers.buyerUsernames.length,
    buyer_emails: identifiers.buyerEmails.length,
  };
}

function workflowCandidates(identifiers: ImportedIdentifiers) {
  const candidates = new Set<string>();
  if (identifiers.returnIds.length) candidates.add("return_request");
  if (identifiers.trackingNumbers.length) candidates.add("shipping_issue");
  if (identifiers.orderNumbers.length) candidates.add("order_reference");
  if (identifiers.itemNumbers.length || identifiers.transactionIds.length || identifiers.titlePhrases.length) {
    candidates.add("item_reference");
  }
  if (identifiers.buyerUsernames.length || identifiers.buyerEmails.length) candidates.add("buyer_message");
  if (!candidates.size) candidates.add("needs_review");
  return [...candidates];
}

function importedProcessingCounters(): ProcessImportedCounters {
  return {
    queued_count: 0,
    processed_count: 0,
    skipped_count: 0,
    failed_count: 0,
    already_processed_count: 0,
    currently_processing_count: 0,
    permanently_failed_count: 0,
    jobs_enqueued: 0,
    jobs_processed: 0,
    jobs_succeeded: 0,
    jobs_failed: 0,
    jobs_skipped: 0,
    links_created: 0,
    links_updated: 0,
  };
}

async function loadApprovedImportedMessageIds(supabase: ServiceClient) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .select("message_ids")
    .eq("event_type", "sync_import_approved")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new SyncError("process_imported_event_lookup_failed", { phase: "process_imported_event_lookup" });
  return [...new Set((data || []).flatMap((row: { message_ids?: string[] | null }) => row.message_ids || []))];
}

async function loadImportedCandidateIds(
  supabase: ServiceClient,
  mailboxId: string,
  approvedMessageIds: string[],
  batchSize: number,
  counters: ProcessImportedCounters,
) {
  if (!approvedMessageIds.length) return [];
  const { data: messages, error: messageError } = await supabase
    .from("email_messages")
    .select("id, received_at, sync_status")
    .eq("mailbox_id", mailboxId)
    .eq("sync_status", "active")
    .in("id", approvedMessageIds)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(batchSize * 4, batchSize));

  if (messageError) throw new SyncError("process_imported_message_lookup_failed", { phase: "process_imported_message_lookup", mailboxId });
  const ids = (messages || []).map((message: { id: string }) => message.id);
  if (!ids.length) return [];

  const { data: jobs, error: jobError } = await supabase
    .from("email_processing_jobs")
    .select("message_id, job_type, status, attempt_count, max_attempts")
    .in("message_id", ids)
    .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
    .eq("input_version", IMPORT_PROCESSOR_VERSION);

  if (jobError) throw new SyncError("process_imported_job_lookup_failed", { phase: "process_imported_job_lookup", mailboxId });

  const byMessage = new Map<string, Array<Record<string, unknown>>>();
  for (const job of jobs || []) {
    const key = String(job.message_id);
    byMessage.set(key, [...(byMessage.get(key) || []), job]);
  }

  const candidates: string[] = [];
  for (const id of ids) {
    const messageJobs = byMessage.get(id) || [];
    const terminalTypes = new Set(
      messageJobs
        .filter((job) => ["succeeded", "skipped"].includes(String(job.status)))
        .map((job) => String(job.job_type)),
    );
    const hasActive = messageJobs.some((job) => ["queued", "running"].includes(String(job.status)));
    const hasPermanentFailure = messageJobs.some((job) =>
      String(job.status) === "failed" &&
      Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)
    );

    if (PROCESS_IMPORTED_JOB_TYPES.every((jobType) => terminalTypes.has(jobType))) {
      counters.already_processed_count += 1;
      continue;
    }
    if (hasActive) {
      counters.currently_processing_count += 1;
      continue;
    }
    if (hasPermanentFailure) {
      counters.permanently_failed_count += 1;
      continue;
    }

    candidates.push(id);
    if (candidates.length >= batchSize) break;
  }

  return candidates;
}

async function enqueueImportedProcessingJobs(supabase: ServiceClient, messageIds: string[]) {
  const rows = messageIds.flatMap((messageId) =>
    PROCESS_IMPORTED_JOB_TYPES.map((jobType) => ({
      message_id: messageId,
      job_type: jobType,
      input_version: IMPORT_PROCESSOR_VERSION,
      status: "queued",
      priority: jobType === "normalize" ? 50 : 60,
      metadata: {
        processor_version: IMPORT_PROCESSOR_VERSION,
        enqueue_source: "microsoft-email-sync:process_imported",
        deterministic_only: true,
      },
    }))
  );

  if (!rows.length) return 0;
  const { data, error } = await supabase
    .from("email_processing_jobs")
    .upsert(rows, { onConflict: "message_id,job_type,input_version", ignoreDuplicates: true })
    .select("id");

  if (error) throw new SyncError("process_imported_enqueue_failed", { phase: "process_imported_enqueue" });
  return data?.length || 0;
}

async function claimImportedJobs(supabase: ServiceClient, messageIds: string[], jobLimit: number) {
  if (!messageIds.length) return [];
  const { data, error } = await supabase
    .from("email_processing_jobs")
    .select("id, message_id, job_type, status, attempt_count, max_attempts, metadata")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .in("message_id", messageIds)
    .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
    .eq("input_version", IMPORT_PROCESSOR_VERSION)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(jobLimit);

  if (error) throw new SyncError("process_imported_claim_failed", { phase: "process_imported_claim" });
  return (data || []) as ImportedProcessingJob[];
}

async function loadImportedMessageContext(supabase: ServiceClient, messageId: string) {
  const { data: message, error: messageError } = await supabase
    .from("email_messages")
    .select("id, subject, body_preview, from_email, from_name, sender_email, sender_name, received_at, sync_status")
    .eq("id", messageId)
    .maybeSingle();

  if (messageError) throw new SyncError("process_imported_message_lookup_failed", { phase: "process_imported_message_context" });
  if (!message) throw new SyncError("process_imported_message_not_found", { phase: "process_imported_message_context", status: 404 });
  if (message.sync_status !== "active") throw new SyncError("process_imported_message_not_active", { phase: "process_imported_message_context", status: 400 });

  const { data: body, error: bodyError } = await supabase
    .from("email_message_bodies")
    .select("body_text, body_html, normalized_text, normalized_text_sha256, normalization_version")
    .eq("message_id", messageId)
    .maybeSingle();
  if (bodyError) throw new SyncError("process_imported_body_lookup_failed", { phase: "process_imported_body_context" });

  const { data: recipients, error: recipientsError } = await supabase
    .from("email_message_recipients")
    .select("recipient_type, display_name, email, email_normalized")
    .eq("message_id", messageId);
  if (recipientsError) throw new SyncError("process_imported_recipient_lookup_failed", { phase: "process_imported_recipient_context" });

  return {
    message: message as ImportedEmailMessage,
    body: body as ImportedEmailBody | null,
    recipients: (recipients || []) as ImportedEmailRecipient[],
  };
}

function buildImportedSearchText(context: { message: ImportedEmailMessage; body: ImportedEmailBody | null; recipients: ImportedEmailRecipient[] }) {
  const recipientText = context.recipients
    .map((recipient) => [recipient.display_name, recipient.email, recipient.email_normalized].filter(Boolean).join(" "))
    .join(" ");

  return [
    context.message.subject,
    context.message.body_preview,
    context.body?.normalized_text,
    context.message.from_email,
    context.message.from_name,
    context.message.sender_email,
    context.message.sender_name,
    recipientText,
  ].filter(Boolean).join("\n");
}

const GENERIC_IMPORTED_TITLE_WORDS = new Set(["watch", "ring", "bracelet", "chain", "pendant"]);

function isSafeImportedTitlePhrase(value: string) {
  const cleaned = lowerTrim(value).replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (words.length === 1 && GENERIC_IMPORTED_TITLE_WORDS.has(words[0])) return false;
  if (words.every((word) => GENERIC_IMPORTED_TITLE_WORDS.has(word))) return false;
  return cleaned.length >= 8;
}

function extractImportedIdentifiers(context: { message: ImportedEmailMessage; body: ImportedEmailBody | null; recipients: ImportedEmailRecipient[] }) {
  const text = buildImportedSearchText(context);
  const subject = String(context.message.subject || "");
  const participantEmails = [
    context.message.from_email,
    context.message.sender_email,
    ...context.recipients.map((recipient) => recipient.email_normalized || recipient.email),
  ];
  const buyerUsernameFromSubject = subject.match(/^(.+?)\s+sent a message\b/i)?.[1]?.trim();
  const fromNameCandidates = [context.message.from_name, context.message.sender_name]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !value.includes("@") && value.length <= 80);
  const labels = unique(text.match(/#\d+\b/g) || []);
  const customLabelValues = [
    ...Array.from(text.matchAll(/\b(?:custom\s+label|sku|label)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,40})\b/gi), (match) => match[1]),
  ];
  const trackingNumbers = unique([
    ...Array.from(text.matchAll(/\b(?:tracking\s+number|tracking|shipment\s+tracking|shipping\s+barcode|label\s+id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{7,34})\b/gi), (match) =>
      String(match[1] || "").replace(/\s+/g, "").trim()
    ),
  ]).filter((value) => /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 8 && value.length <= 34);
  const titlePhrases = unique([
    ...Array.from(text.matchAll(/\b(?:item|listing|title)\s*(?:title|name)?\s*[:#-]\s*["]?([^"\n\r.]{8,120})/gi), (match) => match[1]),
    ...Array.from(subject.matchAll(/\b(?:re|about|question\s+about)\s*[:#-]\s*["]?([^"\n\r]{8,120})/gi), (match) => match[1]),
  ])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => isSafeImportedTitlePhrase(value))
    .slice(0, 10);

  return {
    orderNumbers: unique(text.match(/\b\d{2}-\d{5}-\d{5}\b/g) || []),
    itemNumbers: unique(text.match(/\b\d{12}\b/g) || []),
    transactionIds: unique(text.match(/\b\d{14}\b/g) || []),
    labels,
    labelValues: unique([...labels.map((label) => label.replace(/^#/, "")), ...customLabelValues]),
    returnIds: unique([
      ...Array.from(text.matchAll(/\b(?:return\s+(?:case\s+)?id|ebay\s+return\s+id|return)\s*[:#-]?\s*([A-Z0-9-]{6,40})\b/gi), (match) => match[1]),
    ]).filter((value) => /\d/.test(value)),
    trackingNumbers,
    titlePhrases,
    buyerUsernames: uniqueLower([buyerUsernameFromSubject, ...fromNameCandidates]),
    buyerEmails: uniqueLower([
      ...participantEmails,
      ...(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []),
    ]),
  } satisfies ImportedIdentifiers;
}

function isMaskedImportedBuyerEmail(value: string) {
  const email = lowerTrim(value);
  return !email ||
    email.includes("members.ebay") ||
    email.includes("member.ebay") ||
    email.includes("reply.ebay") ||
    email.includes("ebay.com") ||
    email.includes("no-reply") ||
    email.includes("noreply");
}

async function normalizeImportedMessage(supabase: ServiceClient, messageId: string) {
  const context = await loadImportedMessageContext(supabase, messageId);
  if (context.body?.normalized_text && context.body.normalization_version === IMPORT_PROCESSOR_VERSION) {
    return { skipped: true, metadata: { processor_version: IMPORT_PROCESSOR_VERSION, normalized: false, reason: "already_normalized_v1" } };
  }

  const source = context.body?.body_text || (context.body?.body_html ? stripHtml(context.body.body_html) : context.message.body_preview || "");
  const normalizedText = normalizeImportedText(source);
  const normalizedHash = normalizedText ? await sha256Hex(normalizedText) : null;
  const nowIso = new Date().toISOString();
  const bodyPatch: Record<string, unknown> = {
    message_id: messageId,
    normalized_text: normalizedText || null,
    normalized_text_sha256: normalizedHash,
    normalization_version: IMPORT_PROCESSOR_VERSION,
    metadata: {
      ...(context.body ? {} : { source: "microsoft-email-sync:process_imported" }),
      normalization_processor: IMPORT_PROCESSOR_VERSION,
      deterministic_only: true,
    },
    stored_at: nowIso,
    updated_at: nowIso,
  };
  if (!context.body) bodyPatch.redaction_status = "body_omitted";

  const { error } = await supabase.from("email_message_bodies").upsert(bodyPatch, { onConflict: "message_id" });
  if (error) throw new SyncError("process_imported_normalization_failed", { phase: "process_imported_body_update" });
  return {
    skipped: !normalizedText,
    metadata: {
      processor_version: IMPORT_PROCESSOR_VERSION,
      deterministic_only: true,
      normalized: Boolean(normalizedText),
      normalized_text_sha256: normalizedHash,
    },
  };
}

async function queryImportedByChunks<T>(values: string[], load: (chunk: string[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (let index = 0; index < values.length; index += 50) {
    rows.push(...await load(values.slice(index, index + 50)));
  }
  return rows;
}

function importedOrderLineSelect() {
  return "id, order_id, item_number, transaction_id, item_title, custom_label, internal_item_id, sale_id, order:ebay_orders(id, order_number, buyer_username, buyer_email, sale_date, paid_on_date)";
}

function importedLinkMetadata(identifiers: ImportedIdentifiers, matchedBy: string, extra: Record<string, unknown> = {}) {
  return {
    processor_version: IMPORT_PROCESSOR_VERSION,
    deterministic_only: true,
    matched_by: matchedBy,
    extracted_identifiers: importedIdentifiersSummary(identifiers),
    workflow_candidates: workflowCandidates(identifiers),
    ...extra,
  };
}

async function upsertImportedLink(supabase: ServiceClient, candidate: ImportedLinkCandidate) {
  let lookup = supabase
    .from("email_message_links")
    .select("id, confidence, status")
    .eq("message_id", candidate.message_id)
    .eq("link_type", candidate.link_type)
    .in("status", ["suggested", "confirmed"]);

  lookup = candidate.ebay_order_id ? lookup.eq("ebay_order_id", candidate.ebay_order_id) : lookup.is("ebay_order_id", null);
  lookup = candidate.ebay_order_line_id ? lookup.eq("ebay_order_line_id", candidate.ebay_order_line_id) : lookup.is("ebay_order_line_id", null);
  lookup = candidate.item_id ? lookup.eq("item_id", candidate.item_id) : lookup.is("item_id", null);
  lookup = candidate.sale_id ? lookup.eq("sale_id", candidate.sale_id) : lookup.is("sale_id", null);

  const { data: existingRows, error: lookupError } = await lookup.limit(5);
  if (lookupError) throw new SyncError("process_imported_link_failed", { phase: "process_imported_link_lookup" });

  const rows = Array.isArray(existingRows) ? existingRows : [];
  const existing = rows.find((row) => row.status === candidate.status) ||
    rows.find((row) => row.status === "suggested") ||
    rows[0] ||
    null;
  if (existing?.id) {
    const shouldImprove = Number(candidate.confidence) > Number(existing.confidence || 0) ||
      (existing.status === "suggested" && candidate.status === "confirmed");
    if (!shouldImprove) return { created: 0, updated: 0 };

    const { error } = await supabase
      .from("email_message_links")
      .update({
        confidence: candidate.confidence,
        status: candidate.status,
        match_method: candidate.match_method,
        matched_value: candidate.matched_value,
        metadata: candidate.metadata,
      })
      .eq("id", existing.id);

    if (error) throw new SyncError("process_imported_link_failed", { phase: "process_imported_link_update" });
    return { created: 0, updated: 1 };
  }

  const { error } = await supabase.from("email_message_links").insert(candidate);
  if (error) throw new SyncError("process_imported_link_failed", { phase: "process_imported_link_insert" });
  return { created: 1, updated: 0 };
}

async function matchImportedMessage(supabase: ServiceClient, messageId: string) {
  const context = await loadImportedMessageContext(supabase, messageId);
  const identifiers = extractImportedIdentifiers(context);
  const candidates: ImportedLinkCandidate[] = [];
  const ambiguity: Record<string, unknown> = {};

  if (identifiers.orderNumbers.length) {
    const orders = await queryImportedByChunks(identifiers.orderNumbers, async (chunk) => {
      const { data, error } = await supabase.from("ebay_orders").select("id, order_number").in("order_number", chunk);
      if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_order_lookup" });
      return data || [];
    });
    for (const order of orders as Array<{ id: string; order_number: string }>) {
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order",
        ebay_order_id: order.id,
        matched_value: order.order_number,
        match_method: "order_number_exact",
        confidence: 1.0,
        status: "confirmed",
        metadata: importedLinkMetadata(identifiers, "order_number_exact"),
      });
    }
  }

  if (identifiers.returnIds.length) {
    const returnCases = await queryImportedByChunks(identifiers.returnIds, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("id, order_id, ebay_return_id, status")
        .in("ebay_return_id", chunk);
      if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_return_lookup" });
      return data || [];
    });
    for (const returnCase of returnCases as Array<Record<string, any>>) {
      if (!returnCase.order_id) {
        ambiguity[`return_id:${returnCase.ebay_return_id || returnCase.id}`] = "return_case_has_no_order_link";
        continue;
      }
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order",
        ebay_order_id: String(returnCase.order_id),
        matched_value: String(returnCase.ebay_return_id || returnCase.id),
        match_method: "return_id_exact",
        confidence: 1.0,
        status: "confirmed",
        metadata: importedLinkMetadata(identifiers, "return_id_exact", {
          return_case_id: returnCase.id,
          return_status: returnCase.status,
        }),
      });
    }
  }

  if (identifiers.itemNumbers.length && identifiers.transactionIds.length) {
    const lines = await queryImportedByChunks(identifiers.itemNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(importedOrderLineSelect())
        .in("item_number", chunk)
        .in("transaction_id", identifiers.transactionIds);
      if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_item_transaction_lookup" });
      return data || [];
    });
    for (const line of lines as Array<Record<string, any>>) {
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order_line",
        ebay_order_line_id: String(line.id),
        ebay_order_id: String(line.order_id || ""),
        item_id: line.internal_item_id || null,
        sale_id: line.sale_id || null,
        matched_value: `${line.item_number}:${line.transaction_id}`,
        match_method: "item_transaction_exact",
        confidence: 1.0,
        status: "confirmed",
        metadata: importedLinkMetadata(identifiers, "item_transaction_exact"),
      });
    }
  }

  if (identifiers.itemNumbers.length) {
    const lines = await queryImportedByChunks(identifiers.itemNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(importedOrderLineSelect())
        .in("item_number", chunk);
      if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_item_lookup" });
      return data || [];
    });
    const byItem = new Map<string, Array<Record<string, any>>>();
    for (const line of lines as Array<Record<string, any>>) {
      const itemNumber = String(line.item_number || "");
      byItem.set(itemNumber, [...(byItem.get(itemNumber) || []), line]);
    }
    for (const [itemNumber, matchedLines] of byItem) {
      const alreadyHasStrong = candidates.some((candidate) =>
        candidate.link_type === "ebay_order_line" &&
        candidate.match_method === "item_transaction_exact" &&
        candidate.matched_value.startsWith(`${itemNumber}:`)
      );
      if (alreadyHasStrong) continue;
      if (matchedLines.length === 1) {
        const line = matchedLines[0];
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order_line",
          ebay_order_line_id: String(line.id),
          ebay_order_id: String(line.order_id || ""),
          item_id: line.internal_item_id || null,
          sale_id: line.sale_id || null,
          matched_value: itemNumber,
          match_method: "item_number_exact",
          confidence: 0.8,
          status: "suggested",
          metadata: importedLinkMetadata(identifiers, "item_number_exact"),
        });
      } else if (matchedLines.length > 1) {
        ambiguity[`item_number:${itemNumber}`] = matchedLines.length;
      }
    }
  }

  if (identifiers.buyerUsernames.length) {
    const orders: Array<Record<string, unknown>> = [];
    for (const username of identifiers.buyerUsernames.slice(0, 10)) {
      const { data, error } = await supabase
        .from("ebay_orders")
        .select("id, order_number, buyer_username")
        .ilike("buyer_username", username);
      if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_buyer_username_lookup" });
      orders.push(...(data || []));
    }
    const hasStrongContext = identifiers.orderNumbers.length > 0 ||
      identifiers.itemNumbers.length > 0 ||
      identifiers.labelValues.length > 0 ||
      identifiers.trackingNumbers.length > 0 ||
      identifiers.returnIds.length > 0;
    if (hasStrongContext) {
      for (const order of orders as Array<{ id: string; buyer_username: string }>) {
        if (candidates.some((candidate) => candidate.ebay_order_id === order.id)) continue;
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order",
          ebay_order_id: order.id,
          matched_value: order.buyer_username,
          match_method: "buyer_username_plus_strong_clue",
          confidence: 0.65,
          status: "suggested",
          metadata: importedLinkMetadata(identifiers, "buyer_username_plus_strong_clue", { guarded_by_context: true }),
        });
      }
    } else if (orders.length === 1) {
      const order = orders[0] as { id: string; buyer_username: string };
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order",
        ebay_order_id: order.id,
        matched_value: order.buyer_username,
        match_method: "buyer_username_alone_unique",
        confidence: 0.45,
        status: "suggested",
        metadata: importedLinkMetadata(identifiers, "buyer_username_alone_unique", { buyer_username_only: true }),
      });
    } else if (orders.length) {
      ambiguity.buyer_username_context_required = true;
    }
  }

  if (identifiers.buyerEmails.length) {
    const usableEmails = identifiers.buyerEmails.filter((email) => !isMaskedImportedBuyerEmail(email));
    const hasStrongContext = identifiers.orderNumbers.length > 0 ||
      identifiers.itemNumbers.length > 0 ||
      identifiers.labelValues.length > 0 ||
      identifiers.trackingNumbers.length > 0 ||
      identifiers.returnIds.length > 0;
    if (usableEmails.length && hasStrongContext) {
      const orders = await queryImportedByChunks(usableEmails.slice(0, 10), async (chunk) => {
        const { data, error } = await supabase
          .from("ebay_orders")
          .select("id, order_number, buyer_email, buyer_username")
          .in("buyer_email", chunk);
        if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_buyer_email_lookup" });
        return data || [];
      });
      for (const order of orders as Array<Record<string, any>>) {
        if (candidates.some((candidate) => candidate.ebay_order_id === order.id)) continue;
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order",
          ebay_order_id: String(order.id),
          matched_value: String(order.buyer_email || ""),
          match_method: "buyer_email_plus_strong_clue",
          confidence: 0.65,
          status: "suggested",
          metadata: importedLinkMetadata(identifiers, "buyer_email_plus_strong_clue", { masked_email_excluded: true }),
        });
      }
    } else if (identifiers.buyerEmails.some(isMaskedImportedBuyerEmail)) {
      ambiguity.buyer_email_masked_or_unreliable = true;
    }
  }

  if (identifiers.labelValues.length) {
    const labelCandidates = unique([...identifiers.labels, ...identifiers.labelValues]);
    const lineMatches = await queryImportedByChunks(labelCandidates, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(importedOrderLineSelect())
        .in("custom_label", chunk);
      if (error) throw new SyncError("process_imported_matching_failed", { phase: "process_imported_custom_label_lookup" });
      return data || [];
    });
    const byLabel = new Map<string, Array<Record<string, any>>>();
    for (const line of lineMatches as Array<Record<string, any>>) {
      const key = String(line.custom_label || "");
      byLabel.set(key, [...(byLabel.get(key) || []), line]);
    }
    for (const [label, lines] of byLabel) {
      if (lines.length === 1) {
        const line = lines[0];
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order_line",
          ebay_order_line_id: String(line.id),
          ebay_order_id: String(line.order_id || ""),
          item_id: line.internal_item_id || null,
          sale_id: line.sale_id || null,
          matched_value: label,
          match_method: "internal_label_custom_label_exact",
          confidence: 0.78,
          status: "suggested",
          metadata: importedLinkMetadata(identifiers, "internal_label_custom_label_exact"),
        });
      } else if (lines.length > 1) {
        ambiguity[`custom_label:${label}`] = lines.length;
      }
    }
  }

  const deduped = new Map<string, ImportedLinkCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.link_type,
      candidate.ebay_order_id || "",
      candidate.ebay_order_line_id || "",
      candidate.item_id || "",
      candidate.sale_id || "",
      candidate.status,
    ].join(":");
    const existing = deduped.get(key);
    if (!existing || candidate.confidence > existing.confidence) deduped.set(key, candidate);
  }

  let linksCreated = 0;
  let linksUpdated = 0;
  for (const candidate of deduped.values()) {
    const result = await upsertImportedLink(supabase, candidate);
    linksCreated += result.created;
    linksUpdated += result.updated;
  }

  return {
    skipped: deduped.size === 0,
    identifiers,
    links_created: linksCreated,
    links_updated: linksUpdated,
    metadata: {
      processor_version: IMPORT_PROCESSOR_VERSION,
      deterministic_only: true,
      identifiers_found: importedIdentifiersSummary(identifiers),
      workflow_candidates: workflowCandidates(identifiers),
      links_created: linksCreated,
      links_updated: linksUpdated,
      ambiguity,
    },
  };
}

async function markImportedJob(
  supabase: ServiceClient,
  job: ImportedProcessingJob,
  status: "running" | "succeeded" | "failed" | "skipped",
  values: Record<string, unknown> = {},
) {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { status, ...values };
  if (status === "running") {
    patch.started_at = nowIso;
    patch.locked_at = nowIso;
    patch.locked_by = PROCESS_IMPORTED_LOCKED_BY;
    patch.attempt_count = Number(job.attempt_count || 0) + 1;
  }
  if (["succeeded", "failed", "skipped"].includes(status)) {
    patch.completed_at = nowIso;
    patch.locked_at = null;
    patch.locked_by = null;
  }

  let query = supabase.from("email_processing_jobs").update(patch).eq("id", job.id);
  if (status === "running") query = query.eq("status", "queued");
  const { data, error } = await query.select("id").maybeSingle();
  if (error || !data?.id) throw new SyncError("process_imported_claim_failed", { phase: "process_imported_job_update" });
}

async function processImportedJob(supabase: ServiceClient, job: ImportedProcessingJob) {
  await markImportedJob(supabase, job, "running");
  try {
    if (job.job_type === "normalize") {
      const result = await normalizeImportedMessage(supabase, job.message_id);
      await markImportedJob(supabase, job, result.skipped ? "skipped" : "succeeded", {
        last_error_code: null,
        last_error_message: null,
        metadata: result.metadata,
      });
      return { status: result.skipped ? "skipped" as const : "succeeded" as const, links_created: 0, links_updated: 0, metadata: result.metadata };
    }

    const result = await matchImportedMessage(supabase, job.message_id);
    await markImportedJob(supabase, job, result.skipped ? "skipped" : "succeeded", {
      last_error_code: null,
      last_error_message: null,
      metadata: result.metadata,
    });
    return {
      status: result.skipped ? "skipped" as const : "succeeded" as const,
      links_created: result.links_created,
      links_updated: result.links_updated,
      metadata: result.metadata,
    };
  } catch (error) {
    const safe = safeError(error);
    await markImportedJob(supabase, job, "failed", {
      last_error_code: safe.code,
      last_error_message: safe.code,
      metadata: {
        processor_version: IMPORT_PROCESSOR_VERSION,
        deterministic_only: true,
        error: safe.code,
        phase: safe.phase,
      },
    }).catch(() => undefined);
    throw safe;
  }
}

function durationMs(startedAt?: string | null, completedAt?: string | null) {
  if (!startedAt || !completedAt) return null;
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}

async function buildImportedQueueSummary(supabase: ServiceClient, approvedMessageIds: string[]) {
  if (!approvedMessageIds.length) {
    return {
      queued: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      deterministic_match_indicators: {},
      processing_duration_ms: { count: 0, min: null, max: null, avg: null },
    };
  }

  const { data: jobs, error } = await supabase
    .from("email_processing_jobs")
    .select("status, metadata, started_at, completed_at")
    .in("message_id", approvedMessageIds.slice(0, 500))
    .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
    .eq("input_version", IMPORT_PROCESSOR_VERSION)
    .order("updated_at", { ascending: false })
    .limit(1000);

  if (error) throw new SyncError("process_imported_summary_failed", { phase: "process_imported_summary" });
  const statusCounts: Record<string, number> = {};
  const indicators: Record<string, number> = {};
  const durations: number[] = [];
  for (const job of jobs || []) {
    const status = String(job.status || "unknown");
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const metadata = job.metadata && typeof job.metadata === "object" ? job.metadata as Record<string, any> : {};
    const found = metadata.identifiers_found && typeof metadata.identifiers_found === "object"
      ? metadata.identifiers_found as Record<string, unknown>
      : {};
    for (const [key, value] of Object.entries(found)) {
      indicators[key] = (indicators[key] || 0) + Number(value || 0);
    }
    for (const candidate of Array.isArray(metadata.workflow_candidates) ? metadata.workflow_candidates : []) {
      indicators[`workflow:${candidate}`] = (indicators[`workflow:${candidate}`] || 0) + 1;
    }
    const duration = durationMs(job.started_at, job.completed_at);
    if (duration !== null) durations.push(duration);
  }

  return {
    queued: statusCounts.queued || 0,
    running: statusCounts.running || 0,
    succeeded: statusCounts.succeeded || 0,
    skipped: statusCounts.skipped || 0,
    failed: statusCounts.failed || 0,
    deterministic_match_indicators: indicators,
    processing_duration_ms: {
      count: durations.length,
      min: durations.length ? Math.min(...durations) : null,
      max: durations.length ? Math.max(...durations) : null,
      avg: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    },
  };
}

async function processImportedEmails(
  supabase: ServiceClient,
  mailboxId: string,
  input: ProcessImportedInput,
) {
  const counters = importedProcessingCounters();
  const approvedMessageIds = await loadApprovedImportedMessageIds(supabase);
  const candidateMessageIds = await loadImportedCandidateIds(supabase, mailboxId, approvedMessageIds, input.batchSize, counters);
  counters.queued_count = candidateMessageIds.length;
  counters.jobs_enqueued = await enqueueImportedProcessingJobs(supabase, candidateMessageIds);

  const jobs = await claimImportedJobs(supabase, candidateMessageIds, input.batchSize * PROCESS_IMPORTED_JOB_TYPES.length);
  const processingReasons: Record<string, number> = {};
  const deterministicResults: Array<Record<string, unknown>> = [];
  for (const job of jobs) {
    try {
      const result = await processImportedJob(supabase, job);
      counters.jobs_processed += 1;
      counters.processed_count += 1;
      if (result.status === "succeeded") counters.jobs_succeeded += 1;
      if (result.status === "skipped") {
        counters.jobs_skipped += 1;
        counters.skipped_count += 1;
      }
      counters.links_created += result.links_created;
      counters.links_updated += result.links_updated;
      for (const candidate of Array.isArray((result.metadata as Record<string, any>)?.workflow_candidates)
        ? (result.metadata as Record<string, any>).workflow_candidates
        : []) {
        processingReasons[String(candidate)] = (processingReasons[String(candidate)] || 0) + 1;
      }
      deterministicResults.push({
        message_id: job.message_id,
        job_type: job.job_type,
        status: result.status,
        identifiers_found: (result.metadata as Record<string, unknown>)?.identifiers_found || null,
        workflow_candidates: (result.metadata as Record<string, unknown>)?.workflow_candidates || [],
        links_created: result.links_created,
        links_updated: result.links_updated,
      });
    } catch (error) {
      const safe = safeError(error);
      counters.jobs_processed += 1;
      counters.jobs_failed += 1;
      counters.failed_count += 1;
      processingReasons[safe.code] = (processingReasons[safe.code] || 0) + 1;
      console.error("[microsoft-email-sync] process_imported job failed", {
        phase: safe.phase,
        error: safe.code,
        job_id: job.id,
        message_id: job.message_id,
        job_type: job.job_type,
      });
    }
  }

  const queueSummary = await buildImportedQueueSummary(supabase, approvedMessageIds);
  return {
    ...counters,
    approved_imported_message_count: approvedMessageIds.length,
    candidate_message_ids: candidateMessageIds,
    processing_reasons: processingReasons,
    deterministic_results: deterministicResults,
    queue_summary: queueSummary,
  };
}

function classifyImportedCounters(): ClassifyImportedCounters {
  return {
    classified_count: 0,
    skipped_count: 0,
    failed_count: 0,
    already_classified_count: 0,
    currently_classifying_count: 0,
    permanently_failed_count: 0,
    processing_incomplete_count: 0,
    processing_failed_count: 0,
    jobs_enqueued: 0,
    jobs_processed: 0,
    jobs_succeeded: 0,
    jobs_failed: 0,
    jobs_skipped: 0,
  };
}

function isPermanentFailure(job: Record<string, unknown>) {
  return String(job.status) === "failed" && Number(job.attempt_count || 0) >= Number(job.max_attempts || 3);
}

async function loadClassifyImportedCandidateIds(
  supabase: ServiceClient,
  mailboxId: string,
  approvedMessageIds: string[],
  batchSize: number,
  counters: ClassifyImportedCounters,
) {
  if (!approvedMessageIds.length) return [];
  const { data: messages, error: messageError } = await supabase
    .from("email_messages")
    .select("id, received_at, sync_status")
    .eq("mailbox_id", mailboxId)
    .eq("sync_status", "active")
    .in("id", approvedMessageIds)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(batchSize * 8, batchSize));

  if (messageError) throw new SyncError("classify_imported_message_lookup_failed", { phase: "classify_imported_message_lookup", mailboxId });
  const ids = (messages || []).map((message: { id: string }) => message.id);
  if (!ids.length) return [];

  const { data: processingJobs, error: processingJobError } = await supabase
    .from("email_processing_jobs")
    .select("message_id, job_type, status, attempt_count, max_attempts")
    .in("message_id", ids)
    .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
    .eq("input_version", IMPORT_PROCESSOR_VERSION);

  if (processingJobError) throw new SyncError("classify_imported_processing_lookup_failed", { phase: "classify_imported_processing_lookup", mailboxId });

  const { data: classifyJobs, error: classifyJobError } = await supabase
    .from("email_processing_jobs")
    .select("message_id, status, attempt_count, max_attempts")
    .in("message_id", ids)
    .eq("job_type", "classify");

  if (classifyJobError) throw new SyncError("classify_imported_job_lookup_failed", { phase: "classify_imported_job_lookup", mailboxId });

  const { data: classifications, error: classificationError } = await supabase
    .from("email_message_classifications")
    .select("message_id, source, validation_status, is_current")
    .in("message_id", ids)
    .eq("source", "ai")
    .eq("is_current", true);

  if (classificationError) throw new SyncError("classify_imported_classification_lookup_failed", { phase: "classify_imported_classification_lookup", mailboxId });

  const processingByMessage = new Map<string, Array<Record<string, unknown>>>();
  for (const job of processingJobs || []) {
    const key = String(job.message_id);
    processingByMessage.set(key, [...(processingByMessage.get(key) || []), job]);
  }

  const classifyByMessage = new Map<string, Array<Record<string, unknown>>>();
  for (const job of classifyJobs || []) {
    const key = String(job.message_id);
    classifyByMessage.set(key, [...(classifyByMessage.get(key) || []), job]);
  }

  const classified = new Set<string>();
  for (const row of classifications || []) {
    const validationStatus = String(row.validation_status || "");
    if (!validationStatus || validationStatus === "valid") classified.add(String(row.message_id));
  }

  const candidates: string[] = [];
  for (const id of ids) {
    const processing = processingByMessage.get(id) || [];
    const terminalProcessingTypes = new Set(
      processing
        .filter((job) => ["succeeded", "skipped"].includes(String(job.status)))
        .map((job) => String(job.job_type)),
    );
    const hasFailedProcessing = processing.some(isPermanentFailure);
    const hasCompletedProcessing = PROCESS_IMPORTED_JOB_TYPES.every((jobType) => terminalProcessingTypes.has(jobType));

    if (!hasCompletedProcessing) {
      counters.skipped_count += 1;
      if (hasFailedProcessing) counters.processing_failed_count += 1;
      else counters.processing_incomplete_count += 1;
      continue;
    }

    const classify = classifyByMessage.get(id) || [];
    if (classified.has(id)) {
      counters.already_classified_count += 1;
      counters.skipped_count += 1;
      continue;
    }
    if (classify.some((job) => ["queued", "running"].includes(String(job.status)))) {
      counters.currently_classifying_count += 1;
      counters.skipped_count += 1;
      continue;
    }
    if (classify.some(isPermanentFailure)) {
      counters.permanently_failed_count += 1;
      counters.skipped_count += 1;
      continue;
    }

    candidates.push(id);
    if (candidates.length >= batchSize) break;
  }

  return candidates;
}

async function countRows(supabase: ServiceClient, table: string, build: (query: any) => any) {
  const query = build(supabase.from(table).select("id", { count: "exact", head: true }));
  const { count, error } = await query;
  if (error) throw new SyncError("classify_imported_count_failed", { phase: "classify_imported_count" });
  return count || 0;
}

async function countMailboxProcessingJobs(
  supabase: ServiceClient,
  mailboxId: string,
  status: "queued" | "running",
  phase = "rollout_queue_count",
) {
  const { count, error } = await supabase
    .from("email_processing_jobs")
    .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
    .eq("email_messages.mailbox_id", mailboxId)
    .eq("status", status);

  if (error) throw new SyncError("queue_state_lookup_failed", { phase, mailboxId });
  return count || 0;
}

async function buildRolloutQueueState(supabase: ServiceClient, mailboxId: string) {
  const [queued, running] = await Promise.all([
    countMailboxProcessingJobs(supabase, mailboxId, "queued"),
    countMailboxProcessingJobs(supabase, mailboxId, "running"),
  ]);
  const saturated = queued >= MAX_QUEUED_PROCESSING_JOBS || running >= MAX_RUNNING_PROCESSING_JOBS;
  return { queued, running, saturated };
}

async function countLiveSyncConnections(supabase: ServiceClient, enabled: boolean) {
  const { count, error } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id", { count: "exact", head: true })
    .in("status", ACTIVE_CONNECTION_STATUSES)
    .eq("live_sync_enabled", enabled);

  if (error) throw new SyncError("live_sync_status_failed", { phase: "live_sync_count" });
  return count || 0;
}

async function buildLiveSyncRolloutSummary(supabase: ServiceClient) {
  const [enabledMailboxes, disabledMailboxes] = await Promise.all([
    countLiveSyncConnections(supabase, true),
    countLiveSyncConnections(supabase, false),
  ]);
  return {
    enabled_mailboxes: enabledMailboxes,
    disabled_mailboxes: disabledMailboxes,
  };
}

function liveSyncSafety() {
  return {
    outlook_mutation_performed: false,
    sync_checkpoint_updated: false,
    sync_triggered: false,
    preview_triggered: false,
    import_triggered: false,
    processing_triggered: false,
    classification_triggered: false,
    drafts_created: 0,
    automatic_responses_sent: 0,
    attachments_fetched: 0,
  };
}

function queueSaturationReason(queueState: { queued: number; running: number; saturated: boolean }) {
  if (queueState.queued >= MAX_QUEUED_PROCESSING_JOBS) return "queued_processing_jobs_at_limit";
  if (queueState.running >= MAX_RUNNING_PROCESSING_JOBS) return "running_processing_jobs_at_limit";
  return null;
}

async function assertQueueHasCapacity(supabase: ServiceClient, mailboxId: string) {
  const queueState = await buildRolloutQueueState(supabase, mailboxId);
  return {
    queue_saturated: queueState.saturated,
    queue_saturation_reason: queueSaturationReason(queueState),
    queue_state: queueState,
    queue_limits: rolloutQueueLimits(),
  };
}

async function countResponseDrafts(supabase: ServiceClient, messageIds: string[]) {
  if (!messageIds.length) return 0;
  return await countRows(supabase, "email_response_drafts", (query) => query.in("message_id", messageIds));
}

async function callClassifierForImportedMessage(req: Request, messageId: string) {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new SyncError("unauthorized", { status: 401, phase: "classify_imported_auth" });
  const baseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (anonKey) headers.apikey = anonKey;
  const response = await fetch(`${baseUrl}/functions/v1/microsoft-email-classify`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "process_message",
      messageId,
      limit: 1,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new SyncError("classify_imported_classifier_failed", {
      phase: "classify_imported_classifier",
      status: response.status || 500,
    });
  }
  return payload as Record<string, unknown>;
}

function incrementSummary(summary: Record<string, number>, value: unknown) {
  const key = String(value || "unknown");
  summary[key] = (summary[key] || 0) + 1;
}

async function loadClassifyImportedSummaries(supabase: ServiceClient, messageIds: string[]) {
  const categorySummary: Record<string, number> = {};
  const prioritySummary: Record<string, number> = {};
  const urgencySummary: Record<string, number> = {};
  if (!messageIds.length) {
    return {
      category_summary: categorySummary,
      priority_summary: prioritySummary,
      urgency_summary: urgencySummary,
    };
  }

  const { data, error } = await supabase
    .from("email_message_classifications")
    .select("category, priority, urgency")
    .in("message_id", messageIds.slice(0, 500))
    .eq("source", "ai")
    .eq("is_current", true)
    .eq("validation_status", "valid")
    .limit(1000);

  if (error) throw new SyncError("classify_imported_summary_failed", { phase: "classify_imported_summary" });
  for (const row of data || []) {
    incrementSummary(categorySummary, row.category);
    incrementSummary(prioritySummary, row.priority);
    incrementSummary(urgencySummary, row.urgency);
  }

  return {
    category_summary: categorySummary,
    priority_summary: prioritySummary,
    urgency_summary: urgencySummary,
  };
}

async function buildClassifyImportedQueueSummary(supabase: ServiceClient, approvedMessageIds: string[]) {
  if (!approvedMessageIds.length) {
    return {
      queued: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      classification_duration_ms: { count: 0, min: null, max: null, avg: null },
    };
  }

  const { data, error } = await supabase
    .from("email_processing_jobs")
    .select("status, started_at, completed_at")
    .in("message_id", approvedMessageIds.slice(0, 500))
    .eq("job_type", "classify")
    .order("updated_at", { ascending: false })
    .limit(1000);

  if (error) throw new SyncError("classify_imported_queue_summary_failed", { phase: "classify_imported_queue_summary" });
  const statusCounts: Record<string, number> = {};
  const durations: number[] = [];
  for (const job of data || []) {
    const status = String(job.status || "unknown");
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const duration = durationMs(job.started_at, job.completed_at);
    if (duration !== null) durations.push(duration);
  }

  return {
    queued: statusCounts.queued || 0,
    running: statusCounts.running || 0,
    succeeded: statusCounts.succeeded || 0,
    skipped: statusCounts.skipped || 0,
    failed: statusCounts.failed || 0,
    classification_duration_ms: {
      count: durations.length,
      min: durations.length ? Math.min(...durations) : null,
      max: durations.length ? Math.max(...durations) : null,
      avg: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    },
  };
}

async function loadClassifyImportedJobIds(supabase: ServiceClient, messageIds: string[]) {
  if (!messageIds.length) return [];
  const { data, error } = await supabase
    .from("email_processing_jobs")
    .select("id")
    .in("message_id", messageIds)
    .eq("job_type", "classify")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new SyncError("classify_imported_job_reference_failed", { phase: "classify_imported_job_reference" });
  return (data || []).map((row: { id: string }) => row.id);
}

async function insertClassifyImportedOperationalEvent(
  supabase: ServiceClient,
  values: {
    mailboxId: string;
    messageIds: string[];
    jobIds: string[];
    initiatedBy: string;
    initiatedByEmail: string | null;
    payload: Record<string, unknown>;
  },
) {
  const { data, error } = await supabase
    .from("email_operational_events")
    .insert({
      event_type: "classify_imported",
      mailbox_id: values.mailboxId,
      message_ids: values.messageIds,
      job_ids: values.jobIds,
      new_job_ids: values.jobIds,
      job_types: ["classify"],
      reason: "Controlled classification gate for approved imported and deterministically processed Outlook emails.",
      initiated_by: values.initiatedBy,
      initiated_by_email: values.initiatedByEmail,
      processor_version: IMPORT_PROCESSOR_VERSION,
      replay_source: "classify_imported",
      payload: values.payload,
    })
    .select("id, created_at")
    .single();

  if (error || !data?.id) {
    console.error("[microsoft-email-sync] classify_imported audit insert failed", {
      phase: "classify_imported_audit",
      mailbox_id: values.mailboxId,
    });
    return null;
  }

  return data as { id: string; created_at: string };
}

async function classifyImportedEmails(
  req: Request,
  supabase: ServiceClient,
  mailboxId: string,
  input: ClassifyImportedInput,
  admin: { userId: string; email: string | null },
) {
  const counters = classifyImportedCounters();
  const approvedMessageIds = await loadApprovedImportedMessageIds(supabase);
  const candidateMessageIds = await loadClassifyImportedCandidateIds(supabase, mailboxId, approvedMessageIds, input.batchSize, counters);
  const draftsBefore = await countResponseDrafts(supabase, candidateMessageIds);
  const classificationResults: Array<Record<string, unknown>> = [];

  for (const messageId of candidateMessageIds) {
    try {
      const result = await callClassifierForImportedMessage(req, messageId);
      const created = Number(result.classifications_created || 0);
      counters.classified_count += created;
      counters.jobs_enqueued += Number(result.jobs_enqueued || 0);
      counters.jobs_processed += Number(result.jobs_processed || 0);
      counters.jobs_succeeded += Number(result.jobs_succeeded || 0);
      counters.jobs_failed += Number(result.jobs_failed || 0);
      counters.jobs_skipped += Number(result.jobs_skipped || 0);
      if (Number(result.jobs_failed || 0) > 0) counters.failed_count += 1;
      if (created === 0 && Number(result.jobs_failed || 0) === 0) counters.skipped_count += 1;
      classificationResults.push({
        message_id: messageId,
        mode: result.mode || "process_message",
        jobs_enqueued: Number(result.jobs_enqueued || 0),
        jobs_processed: Number(result.jobs_processed || 0),
        jobs_succeeded: Number(result.jobs_succeeded || 0),
        jobs_failed: Number(result.jobs_failed || 0),
        jobs_skipped: Number(result.jobs_skipped || 0),
        classifications_created: created,
      });
    } catch (error) {
      const safe = safeError(error);
      counters.failed_count += 1;
      classificationResults.push({
        message_id: messageId,
        status: "failed",
        error: safe.code,
      });
      console.error("[microsoft-email-sync] classify_imported message failed", {
        phase: safe.phase,
        error: safe.code,
        message_id: messageId,
      });
    }
  }

  const draftsAfter = await countResponseDrafts(supabase, candidateMessageIds);
  const draftsCreated = Math.max(draftsAfter - draftsBefore, 0);
  const queueSummary = await buildClassifyImportedQueueSummary(supabase, approvedMessageIds);
  const summaries = await loadClassifyImportedSummaries(supabase, approvedMessageIds);
  const jobIds = await loadClassifyImportedJobIds(supabase, candidateMessageIds);
  const eventPayload = {
    mode: "classify_imported",
    batch_size: input.batchSize,
    candidate_count: candidateMessageIds.length,
    approved_imported_message_count: approvedMessageIds.length,
    classified_count: counters.classified_count,
    skipped_count: counters.skipped_count,
    failed_count: counters.failed_count,
    already_classified_count: counters.already_classified_count,
    currently_classifying_count: counters.currently_classifying_count,
    permanently_failed_count: counters.permanently_failed_count,
    drafts_created: draftsCreated,
    outlook_mutation_performed: false,
    sync_checkpoint_updated: false,
    attachments_fetched: 0,
    automatic_responses_sent: 0,
  };
  const auditEvent = await insertClassifyImportedOperationalEvent(supabase, {
    mailboxId,
    messageIds: candidateMessageIds,
    jobIds,
    initiatedBy: admin.userId,
    initiatedByEmail: admin.email,
    payload: eventPayload,
  });

  return {
    ...counters,
    classification_created: counters.classified_count,
    approved_imported_message_count: approvedMessageIds.length,
    candidate_message_ids: candidateMessageIds,
    classification_results: classificationResults,
    queue_summary: queueSummary,
    ...summaries,
    replay_operation_references: {
      operation_event_id: auditEvent?.id || null,
      operation_event_created_at: auditEvent?.created_at || null,
      job_ids: jobIds,
    },
    drafts_created: draftsCreated,
  };
}

async function diagnosticCountRows(supabase: ServiceClient, table: string, build: (query: any) => any) {
  const { count, error } = await build(supabase.from(table).select("id", { count: "exact", head: true }));
  if (error) throw new SyncError("pipeline_diagnostics_failed", { phase: `pipeline_diagnostics_${table}_count` });
  return count || 0;
}

function blankJobStatusSummary() {
  return { queued: 0, running: 0, succeeded: 0, skipped: 0, failed: 0 };
}

function blankQueueSummary() {
  return { queued: 0, running: 0, succeeded: 0, skipped: 0, failed: 0, permanently_failed: 0 };
}

function incrementNumber(summary: Record<string, number>, key: string, amount = 1) {
  summary[key] = (summary[key] || 0) + amount;
}

function numberFromPayload(payload: Record<string, any>, keys: string[]) {
  return keys.reduce((sum, key) => sum + Number(payload?.[key] || 0), 0);
}

async function countActiveApprovedImportedMessages(supabase: ServiceClient, mailboxId: string, messageIds: string[]) {
  let total = 0;
  for (let index = 0; index < messageIds.length; index += 100) {
    total += await diagnosticCountRows(supabase, "email_messages", (query) =>
      query
        .eq("mailbox_id", mailboxId)
        .eq("sync_status", "active")
        .in("id", messageIds.slice(index, index + 100))
    );
  }
  return total;
}

async function fetchActiveImportedMessageIds(
  supabase: ServiceClient,
  mailboxId: string,
  scanLimit = PIPELINE_VISIBILITY_SCAN_LIMIT,
) {
  const ids: string[] = [];
  let total: number | null = null;

  for (let offset = 0; offset < scanLimit; offset += PIPELINE_VISIBILITY_SCAN_PAGE_SIZE) {
    const to = Math.min(offset + PIPELINE_VISIBILITY_SCAN_PAGE_SIZE - 1, scanLimit - 1);
    const { data, error, count } = await supabase
      .from("email_messages")
      .select("id", { count: "exact" })
      .eq("mailbox_id", mailboxId)
      .eq("sync_status", "active")
      .order("received_at", { ascending: false })
      .range(offset, to);

    if (error) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_visibility_active_messages" });
    if (total === null) total = count || 0;
    for (const row of data || []) {
      if (row.id) ids.push(String(row.id));
    }
    if (!data?.length || data.length < PIPELINE_VISIBILITY_SCAN_PAGE_SIZE) break;
  }

  const activeImportedTotal = total ?? ids.length;
  return {
    ids,
    activeImportedTotal,
    complete: activeImportedTotal <= scanLimit && ids.length >= activeImportedTotal,
    scanLimit,
  };
}

async function buildTablePipelineVisibilitySummary(supabase: ServiceClient, mailboxId: string) {
  const activeMessages = await fetchActiveImportedMessageIds(supabase, mailboxId);
  const [
    currentValidClassifiedImportedTotal,
    processingFailedJobs,
    processingSkippedJobs,
    classificationFailedJobs,
    classificationSkippedJobs,
  ] = await Promise.all([
    diagnosticCountRows(supabase, "email_message_classifications", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id, sync_status)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .eq("email_messages.sync_status", "active")
        .eq("source", "ai")
        .eq("is_current", true)
        .eq("validation_status", "valid")
    ),
    diagnosticCountRows(supabase, "email_processing_jobs", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
        .eq("status", "failed")
    ),
    diagnosticCountRows(supabase, "email_processing_jobs", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
        .eq("status", "skipped")
    ),
    diagnosticCountRows(supabase, "email_processing_jobs", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .eq("job_type", "classify")
        .eq("status", "failed")
    ),
    diagnosticCountRows(supabase, "email_processing_jobs", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .eq("job_type", "classify")
        .eq("status", "skipped")
    ),
  ]);

  const processingByMessage = new Map<string, Set<string>>();
  const classifiedSampleIds = new Set<string>();

  for (let index = 0; index < activeMessages.ids.length; index += 100) {
    const chunk = activeMessages.ids.slice(index, index + 100);
    const { data: processingJobs, error: processingError } = await supabase
      .from("email_processing_jobs")
      .select("message_id, job_type, status")
      .in("message_id", chunk)
      .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
      .in("status", ["succeeded", "skipped"]);
    if (processingError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_visibility_processing" });

    for (const job of processingJobs || []) {
      const messageId = String(job.message_id || "");
      if (!messageId) continue;
      const current = processingByMessage.get(messageId) || new Set<string>();
      current.add(String(job.job_type || ""));
      processingByMessage.set(messageId, current);
    }

    const { data: classifications, error: classificationError } = await supabase
      .from("email_message_classifications")
      .select("message_id")
      .in("message_id", chunk)
      .eq("source", "ai")
      .eq("is_current", true)
      .eq("validation_status", "valid");
    if (classificationError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_visibility_classification" });

    for (const classification of classifications || []) {
      if (classification.message_id) classifiedSampleIds.add(String(classification.message_id));
    }
  }

  let fullyProcessedImportedCount = 0;
  let processedWithoutClassificationCount = 0;
  for (const id of activeMessages.ids) {
    const completedTypes = processingByMessage.get(id) || new Set<string>();
    const fullyProcessed = PROCESS_IMPORTED_JOB_TYPES.every((jobType) => completedTypes.has(jobType));
    if (!fullyProcessed) continue;
    fullyProcessedImportedCount += 1;
    if (!classifiedSampleIds.has(id)) processedWithoutClassificationCount += 1;
  }

  const sampledImportedCount = activeMessages.ids.length;
  const importedWithoutProcessingCount = Math.max(sampledImportedCount - fullyProcessedImportedCount, 0);

  return {
    source: "email_tables",
    scope: activeMessages.complete ? "all_active_imported_rows" : "bounded_active_imported_rows",
    is_limited: !activeMessages.complete,
    scan_limit: activeMessages.scanLimit,
    sampled_imported_count: sampledImportedCount,
    active_imported_total: activeMessages.activeImportedTotal,
    fully_processed_imported_count: fullyProcessedImportedCount,
    current_valid_classified_imported_total: currentValidClassifiedImportedTotal,
    unclassified_imported_total: Math.max(activeMessages.activeImportedTotal - currentValidClassifiedImportedTotal, 0),
    imported_without_processing_count: importedWithoutProcessingCount,
    processed_without_classification_count: processedWithoutClassificationCount,
    processing_failed_jobs: processingFailedJobs,
    processing_skipped_jobs: processingSkippedJobs,
    classification_failed_jobs: classificationFailedJobs,
    classification_skipped_jobs: classificationSkippedJobs,
  };
}

async function buildPipelineGapSummary(
  supabase: ServiceClient,
  mailboxId: string,
  approvedImportedIds: string[],
  activeImportedTotal: number,
) {
  if (!approvedImportedIds.length) {
    return {
      approved_imported_total: 0,
      active_imported_total: 0,
      fully_processed_imported_total: 0,
      current_classified_imported_total: 0,
      imported_without_processing: 0,
      processed_without_classification: 0,
    };
  }

  const processingByMessage = new Map<string, Set<string>>();
  const classifiedImportedIds = new Set<string>();

  for (let index = 0; index < approvedImportedIds.length; index += 100) {
    const chunk = approvedImportedIds.slice(index, index + 100);
    const { data: processingJobs, error: processingError } = await supabase
      .from("email_processing_jobs")
      .select("message_id, job_type, status, email_messages!inner(mailbox_id)")
      .eq("email_messages.mailbox_id", mailboxId)
      .in("message_id", chunk)
      .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
      .in("status", ["succeeded", "skipped"]);
    if (processingError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_gap_processing" });

    for (const job of processingJobs || []) {
      const messageId = String(job.message_id || "");
      if (!messageId) continue;
      const current = processingByMessage.get(messageId) || new Set<string>();
      current.add(String(job.job_type || ""));
      processingByMessage.set(messageId, current);
    }

    const { data: classifications, error: classificationError } = await supabase
      .from("email_message_classifications")
      .select("message_id, email_messages!inner(mailbox_id)")
      .eq("email_messages.mailbox_id", mailboxId)
      .in("message_id", chunk)
      .eq("source", "ai")
      .eq("is_current", true)
      .eq("validation_status", "valid");
    if (classificationError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_gap_classification" });

    for (const classification of classifications || []) {
      if (classification.message_id) classifiedImportedIds.add(String(classification.message_id));
    }
  }

  let fullyProcessedImportedTotal = 0;
  let processedWithoutClassification = 0;
  for (const id of approvedImportedIds) {
    const completedTypes = processingByMessage.get(id) || new Set<string>();
    const fullyProcessed = PROCESS_IMPORTED_JOB_TYPES.every((jobType) => completedTypes.has(jobType));
    if (!fullyProcessed) continue;
    fullyProcessedImportedTotal += 1;
    if (!classifiedImportedIds.has(id)) processedWithoutClassification += 1;
  }

  return {
    approved_imported_total: approvedImportedIds.length,
    active_imported_total: activeImportedTotal,
    fully_processed_imported_total: fullyProcessedImportedTotal,
    current_classified_imported_total: classifiedImportedIds.size,
    imported_without_processing: Math.max(activeImportedTotal - fullyProcessedImportedTotal, 0),
    processed_without_classification: processedWithoutClassification,
  };
}

async function getMailboxLiveSyncEnabled(supabase: ServiceClient, mailboxId: string) {
  const { data: mailbox, error: mailboxError } = await supabase
    .from("email_mailboxes")
    .select("microsoft_connection_id")
    .eq("id", mailboxId)
    .maybeSingle();

  if (mailboxError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_mailbox_connection" });
  const connectionId = mailbox?.microsoft_connection_id;
  if (!connectionId) return false;

  const { data: connection, error: connectionError } = await supabase
    .from("microsoft_mailbox_connections")
    .select("live_sync_enabled")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_live_sync" });
  return connection?.live_sync_enabled === true;
}

async function buildLiveSyncStatus(supabase: ServiceClient, model: Awaited<ReturnType<typeof loadLiveSyncModel>>) {
  return {
    ok: true,
    mode: "live_sync_status",
    mailbox_id: model.mailbox.id,
    live_sync_enabled: model.connection.live_sync_enabled === true,
    rollout: rolloutControls(),
    queue_state: await buildRolloutQueueState(supabase, model.mailbox.id),
    safety: liveSyncSafety(),
  };
}

async function setLiveSyncEnabled(
  supabase: ServiceClient,
  model: Awaited<ReturnType<typeof loadLiveSyncModel>>,
  enabled: boolean,
  admin: { userId: string; email: string | null },
) {
  const previousValue = model.connection.live_sync_enabled === true;
  const { data: updated, error } = await supabase
    .from("microsoft_mailbox_connections")
    .update({
      live_sync_enabled: enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", model.connection.id)
    .select("live_sync_enabled")
    .single();

  if (error || !updated) {
    throw new SyncError("set_live_sync_failed", {
      phase: "set_live_sync_update",
      mailboxId: model.mailbox.id,
      connectionId: model.connection.id,
      status: 500,
    });
  }

  const currentValue = updated.live_sync_enabled === true;
  const auditEvent = await insertSetLiveSyncOperationalEvent(supabase, {
    mailboxId: model.mailbox.id,
    initiatedBy: admin.userId,
    initiatedByEmail: admin.email,
    previousValue,
    currentValue,
  });

  return {
    ok: true,
    mode: "set_live_sync",
    mailbox_id: model.mailbox.id,
    previous_value: previousValue,
    current_value: currentValue,
    replay_operation_reference: {
      operation_event_id: auditEvent?.id || null,
      operation_event_created_at: auditEvent?.created_at || null,
    },
    safety: liveSyncSafety(),
  };
}

function liveRefreshSafety(overrides: Record<string, unknown> = {}) {
  return {
    outlook_mutation_performed: false,
    automatic_responses_sent: 0,
    drafts_created: 0,
    attachments_fetched: 0,
    sync_checkpoint_updated: false,
    polling_started: false,
    scheduler_started: false,
    realtime_listener_started: false,
    ...overrides,
  };
}

async function runLiveRefreshImportStage(
  supabase: ServiceClient,
  model: Awaited<ReturnType<typeof loadModel>>,
  input: RunLiveRefreshInput,
  admin: { userId: string; email: string | null },
) {
  const operationStartedAt = Date.now();
  let refreshToken = "";
  try {
    refreshToken = await decryptRefreshToken(model.secret);
  } catch {
    throw new SyncError("token_refresh_failed", {
      phase: "run_live_refresh_token_decrypt",
      connectionId: model.connection.id,
      mailboxId: model.mailbox.id,
      folderId: model.folder.id,
      status: 401,
    });
  }

  const refreshedToken = await exchangeRefreshToken(refreshToken, model.connection.id);
  if (refreshedToken.refreshToken) {
    await rotateRefreshToken(supabase, model.connection.id, refreshedToken.refreshToken, refreshedToken.refreshTokenExpiresIn);
  }
  await updateConnectionHealth(supabase, model.connection.id, {
    status: "connected",
    access_token_expires_at: accessTokenExpiry(refreshedToken.expiresIn),
    last_error_code: null,
    last_error_at: null,
  });

  const previewInput: PreviewInput = {
    mode: "sync_preview",
    folder: input.folder,
    limit: input.limit,
    daysBack: input.daysBack,
    bucketMode: input.bucketMode,
  };
  const previewPayload = await fetchPreviewMessages(previewMessagesUrl(model.folder.provider_folder_id, previewInput), refreshedToken.accessToken, {
    connectionId: model.connection.id,
    mailboxId: model.mailbox.id,
    folderId: model.folder.id,
  });
  const previewMessages = (previewPayload.value || []).filter((message) => Boolean(message.id));
  const existingMatches = await loadExistingPreviewMatches(supabase, model.mailbox.id, previewMessages);
  const { rows, bucketSummary } = buildPreviewRows(previewMessages, existingMatches);
  const skippedReasons: Record<string, number> = {};
  const messages: Array<{
    provider_message_id: string | null;
    message_id: string | null;
    bucket: EbayBucket | null;
    import_status: "imported" | "already_imported" | "skipped";
    reason_codes: string[];
  }> = [];
  let importedCount = 0;
  let alreadyImportedCount = 0;
  let skippedCount = 0;
  const importedMessageIds: string[] = [];

  for (const row of rows) {
    if (row.bucket !== "likely_ebay") {
      skippedCount += 1;
      incrementReason(skippedReasons, row.bucket);
      continue;
    }

    const providerMessageId = row.provider_message_id;
    if (!providerMessageId) {
      skippedCount += 1;
      incrementReason(skippedReasons, "missing_provider_message_id");
      messages.push({
        provider_message_id: null,
        message_id: null,
        bucket: row.bucket,
        import_status: "skipped",
        reason_codes: ["missing_provider_message_id"],
      });
      continue;
    }

    if (row.already_imported) {
      alreadyImportedCount += 1;
      messages.push({
        provider_message_id: providerMessageId,
        message_id: row.existing_message_id,
        bucket: row.bucket,
        import_status: "already_imported",
        reason_codes: ["already_imported"],
      });
      continue;
    }

    const fullMessage = await fetchFullMessage(providerMessageId, refreshedToken.accessToken, {
      connectionId: model.connection.id,
      mailboxId: model.mailbox.id,
      folderId: model.folder.id,
    });
    const result = await upsertMessage(supabase, model.mailbox.id, model.folder.id, fullMessage);
    await replaceRecipients(supabase, result.messageId, fullMessage);
    await upsertBody(supabase, result.messageId, fullMessage);
    row.already_imported = true;
    row.existing_message_id = result.messageId;
    importedCount += 1;
    importedMessageIds.push(result.messageId);
    messages.push({
      provider_message_id: providerMessageId,
      message_id: result.messageId,
      bucket: row.bucket,
      import_status: "imported",
      reason_codes: row.reason_codes,
    });
  }

  const auditEvent = await insertImportOperationalEvent(supabase, {
    mailboxId: model.mailbox.id,
    messageIds: importedMessageIds,
    initiatedBy: admin.userId,
    initiatedByEmail: admin.email,
    payload: {
      mode: "sync_import_approved",
      parent_mode: "run_live_refresh",
      requested_limit: input.limit,
      requested_daysBack: input.daysBack,
      import_bucket: "likely_ebay",
      imported_count: importedCount,
      skipped_already_imported_count: alreadyImportedCount,
      skipped_not_eligible_count: skippedCount,
      skipped_reasons: skippedReasons,
      classification_created: 0,
      drafts_created: 0,
      duration_ms: Date.now() - operationStartedAt,
      outlook_mutation_performed: false,
      sync_checkpoint_updated: false,
    },
  });

  return {
    preview: {
      previewed_count: previewMessages.length,
      likely_ebay_count: bucketSummary.likely_ebay || 0,
      maybe_ebay_count: bucketSummary.maybe_ebay || 0,
      not_ebay_count: bucketSummary.not_ebay || 0,
      messages_returned: input.bucketMode === "ebay_only"
        ? rows.filter((row) => row.bucket !== "not_ebay").length
        : rows.length,
      messages: input.bucketMode === "ebay_only"
        ? rows.filter((row) => row.bucket !== "not_ebay")
        : rows,
    },
    import: {
      imported_count: importedCount,
      already_imported_count: alreadyImportedCount,
      skipped_count: skippedCount,
      skipped_reasons: skippedReasons,
    },
    child_operation_id: auditEvent?.id || null,
    messages,
  };
}

async function runLiveRefresh(
  req: Request,
  supabase: ServiceClient,
  input: RunLiveRefreshInput,
  admin: { userId: string; email: string | null },
) {
  const startedAt = Date.now();
  const model = await loadModel(supabase);
  const liveSyncModel = await loadLiveSyncModel(supabase);
  const queueState = await assertQueueHasCapacity(supabase, model.mailbox.id);
  const baseSafety = liveRefreshSafety();
  const controls = rolloutControls();
  const parentEvent = await insertRunLiveRefreshOperationalEvent(supabase, {
    mailboxId: model.mailbox.id,
    initiatedBy: admin.userId,
    initiatedByEmail: admin.email,
    payload: {
      mode: "run_live_refresh",
      status: "started",
      requested_limit: input.limit,
      requested_daysBack: input.daysBack,
      process_batch_size: input.processBatchSize,
      classify_batch_size: input.classifyBatchSize,
      live_sync_enabled: liveSyncModel.connection.live_sync_enabled === true,
      queue_state: queueState.queue_state,
      safety: baseSafety,
    },
  });

  if (liveSyncModel.connection.live_sync_enabled !== true) {
    const blockedResult = {
      ok: false,
      mode: "run_live_refresh",
      operation_id: parentEvent.id,
      mailbox_id: model.mailbox.id,
      live_sync_enabled: false,
      blocked: true,
      reason: "live_sync_disabled",
      queue_state: queueState.queue_state,
      queue_limits: queueState.queue_limits,
      child_operations: {},
      duration_ms: Date.now() - startedAt,
      safety: baseSafety,
    };
    await updateRunLiveRefreshOperationalEvent(supabase, parentEvent.id, { ...blockedResult, status: "blocked_live_sync_disabled" });
    return blockedResult;
  }

  const disabledReason = !controls.imports_enabled
    ? "imports_disabled"
    : !controls.processing_enabled
    ? "processing_disabled"
    : !controls.classification_enabled
    ? "classification_disabled"
    : null;
  if (disabledReason) {
    const blockedResult = {
      ok: false,
      mode: "run_live_refresh",
      operation_id: parentEvent.id,
      mailbox_id: model.mailbox.id,
      live_sync_enabled: true,
      disabled: true,
      reason: disabledReason,
      rollout: controls,
      queue_state: queueState.queue_state,
      queue_limits: queueState.queue_limits,
      child_operations: {},
      duration_ms: Date.now() - startedAt,
      safety: baseSafety,
    };
    await updateRunLiveRefreshOperationalEvent(supabase, parentEvent.id, { ...blockedResult, status: "blocked_rollout_disabled" });
    return blockedResult;
  }

  if (queueState.queue_saturated) {
    const blockedResult = {
      ok: false,
      mode: "run_live_refresh",
      operation_id: parentEvent.id,
      mailbox_id: model.mailbox.id,
      live_sync_enabled: true,
      queue_saturated: true,
      queue_saturation_reason: queueState.queue_saturation_reason,
      queue_state: queueState.queue_state,
      queue_limits: queueState.queue_limits,
      child_operations: {},
      duration_ms: Date.now() - startedAt,
      safety: baseSafety,
    };
    await updateRunLiveRefreshOperationalEvent(supabase, parentEvent.id, { ...blockedResult, status: "blocked_queue_saturated" });
    return blockedResult;
  }

  const importStage = await runLiveRefreshImportStage(supabase, model, input, admin);
  const queueAfterImport = await assertQueueHasCapacity(supabase, model.mailbox.id);
  if (queueAfterImport.queue_saturated) {
    const blockedResult = {
      ok: false,
      mode: "run_live_refresh",
      operation_id: parentEvent.id,
      mailbox_id: model.mailbox.id,
      live_sync_enabled: true,
      ...importStage,
      processing: { processed_count: 0, failed_count: 0, skipped_count: 0 },
      classification: { classified_count: 0, failed_count: 0, skipped_count: 0 },
      queue_saturated: true,
      queue_saturation_reason: queueAfterImport.queue_saturation_reason,
      queue_state: queueAfterImport.queue_state,
      queue_limits: queueAfterImport.queue_limits,
      child_operations: {
        import_operation_id: importStage.child_operation_id,
      },
      duration_ms: Date.now() - startedAt,
      safety: baseSafety,
    };
    await updateRunLiveRefreshOperationalEvent(supabase, parentEvent.id, { ...blockedResult, status: "blocked_after_import" });
    return blockedResult;
  }

  const processingResult = await processImportedEmails(supabase, model.mailbox.id, {
    mode: "process_imported",
    folder: "inbox",
    batchSize: input.processBatchSize,
  });
  const queueAfterProcessing = await assertQueueHasCapacity(supabase, model.mailbox.id);
  if (queueAfterProcessing.queue_saturated) {
    const blockedResult = {
      ok: false,
      mode: "run_live_refresh",
      operation_id: parentEvent.id,
      mailbox_id: model.mailbox.id,
      live_sync_enabled: true,
      ...importStage,
      processing: {
        processed_count: Number(processingResult.processed_count || 0),
        failed_count: Number(processingResult.failed_count || 0),
        skipped_count: Number(processingResult.skipped_count || 0),
      },
      classification: { classified_count: 0, failed_count: 0, skipped_count: 0 },
      queue_saturated: true,
      queue_saturation_reason: queueAfterProcessing.queue_saturation_reason,
      queue_state: queueAfterProcessing.queue_state,
      queue_limits: queueAfterProcessing.queue_limits,
      child_operations: {
        import_operation_id: importStage.child_operation_id,
      },
      duration_ms: Date.now() - startedAt,
      safety: baseSafety,
    };
    await updateRunLiveRefreshOperationalEvent(supabase, parentEvent.id, { ...blockedResult, status: "blocked_after_processing" });
    return blockedResult;
  }

  const classificationResult = await classifyImportedEmails(req, supabase, model.mailbox.id, {
    mode: "classify_imported",
    folder: "inbox",
    batchSize: input.classifyBatchSize,
  }, admin);
  const finalQueue = await assertQueueHasCapacity(supabase, model.mailbox.id);
  const result = {
    ok: true,
    mode: "run_live_refresh",
    operation_id: parentEvent.id,
    mailbox_id: model.mailbox.id,
    live_sync_enabled: true,
    requested_limit: input.limit,
    requested_daysBack: input.daysBack,
    bucketMode: input.bucketMode,
    preview: importStage.preview,
    import: importStage.import,
    processing: {
      processed_count: Number(processingResult.processed_count || 0),
      failed_count: Number(processingResult.failed_count || 0),
      skipped_count: Number(processingResult.skipped_count || 0),
      jobs_enqueued: Number(processingResult.jobs_enqueued || 0),
      jobs_processed: Number(processingResult.jobs_processed || 0),
    },
    classification: {
      classified_count: Number(classificationResult.classified_count || 0),
      failed_count: Number(classificationResult.failed_count || 0),
      skipped_count: Number(classificationResult.skipped_count || 0),
      jobs_enqueued: Number(classificationResult.jobs_enqueued || 0),
      jobs_processed: Number(classificationResult.jobs_processed || 0),
    },
    queue_state: finalQueue.queue_state,
    queue_limits: finalQueue.queue_limits,
    child_operations: {
      import_operation_id: importStage.child_operation_id,
      process_operation_id: null,
      classify_operation_id: classificationResult.replay_operation_references?.operation_event_id || null,
    },
    duration_ms: Date.now() - startedAt,
    safety: liveRefreshSafety({
      drafts_created: Number(classificationResult.drafts_created || 0),
    }),
  };

  await updateRunLiveRefreshOperationalEvent(supabase, parentEvent.id, { ...result, status: "completed" });
  return result;
}

async function buildPipelineDiagnostics(supabase: ServiceClient, mailboxId: string, folderId: string) {
  const { data: events, error: eventError } = await supabase
    .from("email_operational_events")
    .select("id, event_type, created_at, reason, initiated_by, initiated_by_email, message_ids, job_ids, new_job_ids, job_types, payload, replay_source")
    .eq("mailbox_id", mailboxId)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (eventError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_events" });

  const operationalEventSummary: Record<string, number> = {};
  const importedMessageIds = new Set<string>();
  let skippedTotal = 0;
  let alreadyImportedTotal = 0;
  let duplicateTotal = 0;
  let latestOperationAt: string | null = null;
  let latestOperationType: string | null = null;
  let importOperations = 0;
  let classifyOperations = 0;
  let processOperations = 0;
  let liveRefreshOperations = 0;
  let rematchOperations = 0;

  for (const event of events || []) {
    const eventType = String(event.event_type || "unknown");
    incrementNumber(operationalEventSummary, eventType);
    if (!latestOperationAt) {
      latestOperationAt = event.created_at || null;
      latestOperationType = eventType;
    }
    if (eventType === "sync_import_approved") importOperations += 1;
    if (["classify_imported", "classification_replay"].includes(eventType)) classifyOperations += 1;
    if (["processing_requeue", "processing_replay", "process_imported"].includes(eventType)) processOperations += 1;
    if (eventType === "run_live_refresh") liveRefreshOperations += 1;
    if (eventType === "rematch_existing") rematchOperations += 1;

    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
    if (eventType === "sync_import_approved") {
      for (const id of event.message_ids || []) importedMessageIds.add(String(id));
      skippedTotal += payload.skipped_count === undefined
        ? Number(payload.skipped_not_eligible_count || 0)
        : Number(payload.skipped_count || 0);
      alreadyImportedTotal += payload.already_imported_count === undefined
        ? Number(payload.skipped_already_imported_count || 0)
        : Number(payload.already_imported_count || 0);
      duplicateTotal += numberFromPayload(payload, ["duplicate_count", "duplicates_count"]);
      const skippedReasons = payload.skipped_reasons && typeof payload.skipped_reasons === "object"
        ? payload.skipped_reasons as Record<string, unknown>
        : {};
      duplicateTotal += Number(skippedReasons.duplicate || 0) + Number(skippedReasons.already_imported || 0);
    }
  }

  if (duplicateTotal === 0 && alreadyImportedTotal > 0) duplicateTotal = alreadyImportedTotal;

  const approvedImportedIds = [...importedMessageIds];
  const activeImportedTotal = approvedImportedIds.length
    ? await countActiveApprovedImportedMessages(supabase, mailboxId, approvedImportedIds)
    : 0;
  const [pipelineGapSummary, tablePipelineVisibilitySummary] = await Promise.all([
    buildPipelineGapSummary(supabase, mailboxId, approvedImportedIds, activeImportedTotal),
    buildTablePipelineVisibilitySummary(supabase, mailboxId),
  ]);

  const importedSummary = {
    approved_imported_total: approvedImportedIds.length,
    active_imported_total: activeImportedTotal,
    skipped_total: skippedTotal,
    duplicate_total: duplicateTotal,
    already_imported_total: alreadyImportedTotal,
  };

  const processingSummary: Record<ProcessImportedJobType, ReturnType<typeof blankJobStatusSummary>> = {
    normalize: blankJobStatusSummary(),
    match_order: blankJobStatusSummary(),
  };
  const queueSummary = blankQueueSummary();
  const failureReasons: Record<string, number> = {};
  let latestProcessingAt: string | null = null;

  for (const jobType of PROCESS_IMPORTED_JOB_TYPES) {
    for (const status of ["queued", "running", "succeeded", "skipped", "failed"] as const) {
      const count = await diagnosticCountRows(supabase, "email_processing_jobs", (query) =>
        query
          .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
          .eq("email_messages.mailbox_id", mailboxId)
          .eq("job_type", jobType)
          .eq("status", status)
      );
      processingSummary[jobType][status] = count;
    }
  }

  for (const status of ["queued", "running", "succeeded", "skipped", "failed"] as const) {
    queueSummary[status] = await diagnosticCountRows(supabase, "email_processing_jobs", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .eq("status", status)
    );
  }

  const { data: failedJobs, error: failedJobError } = await supabase
    .from("email_processing_jobs")
    .select("status, job_type, attempt_count, max_attempts, last_error_code, last_error_message, metadata, updated_at, completed_at, email_messages!inner(mailbox_id)")
    .eq("email_messages.mailbox_id", mailboxId)
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (failedJobError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_failed_jobs" });
  let classificationPermanentFailures = 0;
  for (const job of failedJobs || []) {
    const permanentlyFailed = Number(job.attempt_count || 0) >= Number(job.max_attempts || 3);
    if (permanentlyFailed) queueSummary.permanently_failed += 1;
    if (permanentlyFailed && String(job.job_type || "") === "classify") classificationPermanentFailures += 1;
    const metadata = job.metadata && typeof job.metadata === "object" ? job.metadata as Record<string, any> : {};
    const reason = String(job.last_error_code || metadata.error || job.last_error_message || "unknown");
    incrementNumber(failureReasons, reason);
  }

  const { data: latestProcessingRows, error: latestProcessingError } = await supabase
    .from("email_processing_jobs")
    .select("updated_at, completed_at, email_messages!inner(mailbox_id)")
    .eq("email_messages.mailbox_id", mailboxId)
    .in("job_type", PROCESS_IMPORTED_JOB_TYPES as unknown as string[])
    .order("updated_at", { ascending: false })
    .limit(1);
  if (latestProcessingError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_latest_processing" });
  latestProcessingAt = latestProcessingRows?.[0]?.completed_at || latestProcessingRows?.[0]?.updated_at || null;

  const [
    classifiedTotal,
    currentClassifications,
    inactiveClassifications,
    failedClassificationsTotal,
  ] = await Promise.all([
    diagnosticCountRows(supabase, "email_message_classifications", (query) =>
      query.select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true }).eq("email_messages.mailbox_id", mailboxId)
    ),
    diagnosticCountRows(supabase, "email_message_classifications", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .eq("is_current", true)
    ),
    diagnosticCountRows(supabase, "email_message_classifications", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .eq("is_current", false)
    ),
    diagnosticCountRows(supabase, "email_message_classifications", (query) =>
      query
        .select("id, email_messages!inner(mailbox_id)", { count: "exact", head: true })
        .eq("email_messages.mailbox_id", mailboxId)
        .in("validation_status", ["invalid", "error"])
    ),
  ]);

  const categorySummary: Record<string, number> = {};
  const prioritySummary: Record<string, number> = {};
  const urgencySummary: Record<string, number> = {};
  let latestClassificationAt: string | null = null;
  const { data: classifications, error: classificationError } = await supabase
    .from("email_message_classifications")
    .select("category, priority, urgency, validation_status, classified_at, created_at, email_messages!inner(mailbox_id)")
    .eq("email_messages.mailbox_id", mailboxId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (classificationError) throw new SyncError("pipeline_diagnostics_failed", { phase: "pipeline_diagnostics_classifications" });
  for (const classification of classifications || []) {
    if (!latestClassificationAt) latestClassificationAt = classification.classified_at || classification.created_at || null;
    incrementSummary(categorySummary, classification.category);
    incrementSummary(prioritySummary, classification.priority);
    incrementSummary(urgencySummary, classification.urgency);
    const validationStatus = String(classification.validation_status || "");
    if (["invalid", "error"].includes(validationStatus)) incrementNumber(failureReasons, `classification_${validationStatus}`);
  }

  const classificationSummary = {
    classified_total: classifiedTotal,
    current_classifications: currentClassifications,
    inactive_classifications: inactiveClassifications,
    permanently_failed_total: classificationPermanentFailures,
    category_summary: categorySummary,
    priority_summary: prioritySummary,
    urgency_summary: urgencySummary,
  };

  const latestImportEvent = (events || []).find((event) => String(event.event_type || "") === "sync_import_approved");
  const latestLiveRefreshEvent = (events || []).find((event) => String(event.event_type || "") === "run_live_refresh");
  const latestRematchEvent = (events || []).find((event) => String(event.event_type || "") === "rematch_existing");
  const recentOperationalEvents = (events || []).slice(0, 25).map((event: Record<string, any>) => {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
    const preview = payload.preview && typeof payload.preview === "object" ? payload.preview as Record<string, any> : {};
    const imported = payload.import && typeof payload.import === "object" ? payload.import as Record<string, any> : {};
    const processing = payload.processing && typeof payload.processing === "object" ? payload.processing as Record<string, any> : {};
    const classification = payload.classification && typeof payload.classification === "object" ? payload.classification as Record<string, any> : {};
    return {
      id: event.id,
      event_type: event.event_type,
      created_at: event.created_at,
      reason: event.reason || payload.reason || null,
      initiated_by: event.initiated_by_email || event.initiated_by || payload.initiated_by || null,
      replay_source: event.replay_source || payload.replay_source || null,
      message_count: Array.isArray(event.message_ids) ? event.message_ids.length : 0,
      job_count: Array.isArray(event.job_ids) ? event.job_ids.length : 0,
      new_job_count: Array.isArray(event.new_job_ids) ? event.new_job_ids.length : 0,
      job_types: Array.isArray(event.job_types) ? event.job_types : [],
      counters: {
        previewed_count: numberFromPayload(payload, ["previewed_count"]) + numberFromPayload(preview, ["previewed_count"]),
        imported_count: numberFromPayload(payload, ["imported_count"]) + numberFromPayload(imported, ["imported_count"]),
        already_imported_count: numberFromPayload(payload, ["already_imported_count", "skipped_already_imported_count"]) + numberFromPayload(imported, ["already_imported_count"]),
        processed_count: numberFromPayload(payload, ["processed_count"]) + numberFromPayload(processing, ["processed_count"]),
        classified_count: numberFromPayload(payload, ["classified_count"]) + numberFromPayload(classification, ["classified_count"]),
        rematched_count: numberFromPayload(payload, ["rematched"]),
        links_created: numberFromPayload(payload, ["links_created"]),
        links_updated: numberFromPayload(payload, ["links_updated"]),
        ambiguous_count: numberFromPayload(payload, ["ambiguous"]),
        skipped_count: numberFromPayload(payload, ["skipped_count", "skipped"]) + numberFromPayload(imported, ["skipped_count"]) + numberFromPayload(processing, ["skipped_count"]) + numberFromPayload(classification, ["skipped_count"]),
        failed_count: numberFromPayload(payload, ["failed_count", "failed"]) + numberFromPayload(processing, ["failed_count"]) + numberFromPayload(classification, ["failed_count"]),
        jobs_enqueued: numberFromPayload(payload, ["jobs_enqueued"]),
        duration_ms: numberFromPayload(payload, ["duration_ms"]),
      },
      safety: payload.safety && typeof payload.safety === "object" ? payload.safety : {},
      child_operations: payload.child_operations && typeof payload.child_operations === "object" ? payload.child_operations : {},
      status: payload.status || null,
    };
  });
  const timingSummary = {
    latest_import_at: latestImportEvent?.created_at || null,
    latest_live_refresh_at: latestLiveRefreshEvent?.created_at || null,
    latest_rematch_at: latestRematchEvent?.created_at || null,
    latest_processing_at: latestProcessingAt,
    latest_classification_at: latestClassificationAt,
  };

  return {
    ok: true,
    mode: "pipeline_diagnostics",
    mailbox_id: mailboxId,
    folder_id: folderId,
    live_sync_enabled: await getMailboxLiveSyncEnabled(supabase, mailboxId),
    imported_summary: importedSummary,
    processing_summary: processingSummary,
    classification_summary: classificationSummary,
    pipeline_gap_summary: pipelineGapSummary,
    table_pipeline_visibility_summary: tablePipelineVisibilitySummary,
    replay_summary: {
      import_operations: importOperations,
      classify_operations: classifyOperations,
      process_operations: processOperations,
      live_refresh_operations: liveRefreshOperations,
      rematch_operations: rematchOperations,
      latest_operation_at: latestOperationAt,
      latest_operation_type: latestOperationType,
      replay_safe: true,
    },
    queue_summary: queueSummary,
    recent_operational_events: recentOperationalEvents,
    operational_event_summary: operationalEventSummary,
    failure_summary: {
      failed_jobs_total: queueSummary.failed,
      failed_classifications_total: failedClassificationsTotal,
      failed_reasons: failureReasons,
    },
    timing_summary: timingSummary,
    safety: {
      outlook_mutation_performed: false,
      sync_checkpoint_updated: false,
      drafts_created: 0,
      automatic_responses_sent: 0,
      attachments_fetched: 0,
    },
  };
}

async function buildRolloutStatus(supabase: ServiceClient, mailboxId: string) {
  return {
    ok: true,
    mode: "rollout_status",
    rollout: rolloutControls(),
    live_sync: await buildLiveSyncRolloutSummary(supabase),
    caps: rolloutCaps(),
    queue_limits: rolloutQueueLimits(),
    queue_state: await buildRolloutQueueState(supabase, mailboxId),
    safety: {
      outlook_mutation_performed: false,
      sync_checkpoint_updated: false,
      drafts_created: 0,
      automatic_responses_sent: 0,
      attachments_fetched: 0,
    },
  };
}

function blankCounters(): SyncCounters {
  return {
    graph_request_count: 0,
    pages_fetched: 0,
    messages_seen: 0,
    messages_inserted: 0,
    messages_updated: 0,
    messages_deleted: 0,
    attachments_seen: 0,
    jobs_enqueued: 0,
  };
}

function safeError(error: unknown) {
  if (error instanceof SyncError) return error;
  return new SyncError("unexpected_error");
}

function safeLog(error: SyncError, counters?: Partial<SyncCounters>) {
  return {
    phase: error.phase,
    error: error.code,
    mailbox_id: error.mailboxId,
    folder_id: error.folderId,
    sync_run_id: error.syncRunId,
    status: error.microsoftStatus,
    pages_fetched: counters?.pages_fetched,
    messages_seen: counters?.messages_seen,
    messages_inserted: counters?.messages_inserted,
    messages_updated: counters?.messages_updated,
    messages_deleted: counters?.messages_deleted,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  let supabase: ServiceClient | null = null;
  let syncRunId: string | undefined;
  let syncStateId: string | undefined;
  let mailboxId: string | undefined;
  let folderId: string | undefined;
  let connectionId: string | undefined;
  let previousErrorCount = 0;
  let isPreview = false;
  const counters = blankCounters();

  try {
    supabase = serviceClient();
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const input = await parseInput(req);
    isPreview = input.mode === "sync_preview" ||
      input.mode === "sync_import_approved" ||
      input.mode === "process_imported" ||
      input.mode === "classify_imported" ||
      input.mode === "run_live_refresh" ||
      input.mode === "pipeline_diagnostics" ||
      input.mode === "rollout_status" ||
      input.mode === "live_sync_status" ||
      input.mode === "set_live_sync";

    const controls = rolloutControls();
    if (input.mode === "sync_import_approved" && !controls.imports_enabled) {
      return json(req, 200, { ok: false, disabled: true, reason: "imports_disabled" });
    }
    if (input.mode === "process_imported" && !controls.processing_enabled) {
      return json(req, 200, { ok: false, disabled: true, reason: "processing_disabled" });
    }
    if (input.mode === "classify_imported" && !controls.classification_enabled) {
      return json(req, 200, { ok: false, disabled: true, reason: "classification_disabled" });
    }
    if (input.mode === "rollout_status") {
      const processingModel = await loadProcessingModel(supabase);
      mailboxId = processingModel.mailbox.id;
      folderId = processingModel.folder.id;
      const result = await buildRolloutStatus(supabase, mailboxId);
      console.log("[microsoft-email-sync] rollout_status completed", {
        phase: "rollout_status_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        queued: result.queue_state.queued,
        running: result.queue_state.running,
        saturated: result.queue_state.saturated,
      });

      return json(req, 200, result);
    }

    if (input.mode === "live_sync_status") {
      const liveSyncModel = await loadLiveSyncModel(supabase);
      mailboxId = liveSyncModel.mailbox.id;
      folderId = liveSyncModel.folder.id;
      connectionId = liveSyncModel.connection.id;
      const result = await buildLiveSyncStatus(supabase, liveSyncModel);
      console.log("[microsoft-email-sync] live_sync_status completed", {
        phase: "live_sync_status_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        live_sync_enabled: result.live_sync_enabled,
      });

      return json(req, 200, result);
    }

    if (input.mode === "set_live_sync") {
      const liveSyncModel = await loadLiveSyncModel(supabase);
      mailboxId = liveSyncModel.mailbox.id;
      folderId = liveSyncModel.folder.id;
      connectionId = liveSyncModel.connection.id;
      const result = await setLiveSyncEnabled(supabase, liveSyncModel, input.enabled, admin);
      console.log("[microsoft-email-sync] set_live_sync completed", {
        phase: "set_live_sync_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        previous_value: result.previous_value,
        current_value: result.current_value,
      });

      return json(req, 200, result);
    }

    if (input.mode === "pipeline_diagnostics") {
      const processingModel = await loadProcessingModel(supabase);
      mailboxId = processingModel.mailbox.id;
      folderId = processingModel.folder.id;
      const result = await buildPipelineDiagnostics(supabase, mailboxId, folderId);
      console.log("[microsoft-email-sync] pipeline_diagnostics completed", {
        phase: "pipeline_diagnostics_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        import_operations: result.replay_summary.import_operations,
        classify_operations: result.replay_summary.classify_operations,
        process_operations: result.replay_summary.process_operations,
        failed_jobs_total: result.failure_summary.failed_jobs_total,
      });

      return json(req, 200, result);
    }

    if (input.mode === "run_live_refresh") {
      const result = await runLiveRefresh(req, supabase, input, admin);
      const resultLog = result as Record<string, unknown>;
      console.log("[microsoft-email-sync] run_live_refresh completed", {
        phase: "run_live_refresh_complete",
        mailbox_id: resultLog.mailbox_id,
        operation_id: resultLog.operation_id,
        ok: result.ok,
        queue_saturated: resultLog.queue_saturated === true,
      });

      return json(req, 200, result);
    }

    if (input.mode === "process_imported") {
      const processingModel = await loadProcessingModel(supabase);
      mailboxId = processingModel.mailbox.id;
      folderId = processingModel.folder.id;
      const saturation = await assertQueueHasCapacity(supabase, mailboxId);
      if (saturation.queue_saturated) {
        return json(req, 200, {
          ok: true,
          mode: "process_imported",
          mailbox_id: mailboxId,
          folder_id: folderId,
          batch_size: input.batchSize,
          caps: rolloutCaps(),
          ...saturation,
          jobs_enqueued: 0,
          jobs_processed: 0,
          classification_created: 0,
          drafts_created: 0,
          outlook_mutation_performed: false,
          sync_checkpoint_updated: false,
          attachments_fetched: 0,
          automatic_responses_sent: 0,
        });
      }
      const result = await processImportedEmails(supabase, mailboxId, input);
      console.log("[microsoft-email-sync] process_imported completed", {
        phase: "process_imported_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        batch_size: input.batchSize,
        queued_count: result.queued_count,
        processed_count: result.processed_count,
        skipped_count: result.skipped_count,
        failed_count: result.failed_count,
        already_processed_count: result.already_processed_count,
        currently_processing_count: result.currently_processing_count,
      });

      return json(req, 200, {
        ok: true,
        mode: "process_imported",
        mailbox_id: mailboxId,
        folder_id: folderId,
        batch_size: input.batchSize,
        caps: {
          default_batch_size: PROCESS_IMPORTED_DEFAULT_BATCH_SIZE,
          max_batch_size: PROCESS_IMPORTED_MAX_BATCH_SIZE,
          max_process_batch: MAX_PROCESS_BATCH,
        },
        queue_saturated: false,
        queue_saturation_reason: null,
        queue_limits: saturation.queue_limits,
        queue_state: saturation.queue_state,
        ...result,
        classification_created: 0,
        drafts_created: 0,
        outlook_mutation_performed: false,
        sync_checkpoint_updated: false,
        attachments_fetched: 0,
        automatic_responses_sent: 0,
      });
    }

    if (input.mode === "classify_imported") {
      const processingModel = await loadProcessingModel(supabase);
      mailboxId = processingModel.mailbox.id;
      folderId = processingModel.folder.id;
      const saturation = await assertQueueHasCapacity(supabase, mailboxId);
      if (saturation.queue_saturated) {
        return json(req, 200, {
          ok: true,
          mode: "classify_imported",
          mailbox_id: mailboxId,
          folder_id: folderId,
          batch_size: input.batchSize,
          caps: rolloutCaps(),
          ...saturation,
          jobs_enqueued: 0,
          jobs_processed: 0,
          classification_created: 0,
          classified_count: 0,
          drafts_created: 0,
          outlook_mutation_performed: false,
          sync_checkpoint_updated: false,
          attachments_fetched: 0,
          automatic_responses_sent: 0,
        });
      }
      const result = await classifyImportedEmails(req, supabase, mailboxId, input, admin);
      console.log("[microsoft-email-sync] classify_imported completed", {
        phase: "classify_imported_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        batch_size: input.batchSize,
        classified_count: result.classified_count,
        skipped_count: result.skipped_count,
        failed_count: result.failed_count,
        already_classified_count: result.already_classified_count,
        currently_classifying_count: result.currently_classifying_count,
        drafts_created: result.drafts_created,
      });

      return json(req, 200, {
        ok: true,
        mode: "classify_imported",
        mailbox_id: mailboxId,
        folder_id: folderId,
        batch_size: input.batchSize,
        caps: {
          default_batch_size: CLASSIFY_IMPORTED_DEFAULT_BATCH_SIZE,
          max_batch_size: CLASSIFY_IMPORTED_MAX_BATCH_SIZE,
          max_classification_batch: MAX_CLASSIFICATION_BATCH,
        },
        queue_saturated: false,
        queue_saturation_reason: null,
        queue_limits: saturation.queue_limits,
        queue_state: saturation.queue_state,
        ...result,
        outlook_mutation_performed: false,
        sync_checkpoint_updated: false,
        attachments_fetched: 0,
        automatic_responses_sent: 0,
      });
    }

    const model = await loadModel(supabase);
    mailboxId = model.mailbox.id;
    folderId = model.folder.id;
    syncStateId = model.syncState.id;
    connectionId = model.connection.id;
    previousErrorCount = Number(model.syncState.consecutive_error_count || 0);

    if (input.mode === "sync_preview" || input.mode === "sync_import_approved") {
      const operationStartedAt = Date.now();
      if (input.mode === "sync_import_approved" && input.confirmImport !== IMPORT_APPROVAL_CONFIRMATION) {
        return json(req, 400, {
          ok: false,
          error: "import_confirmation_required",
          required_confirmImport: IMPORT_APPROVAL_CONFIRMATION,
          outlook_mutation_performed: false,
          classification_created: 0,
          drafts_created: 0,
        });
      }
      if (input.mode === "sync_import_approved" && input.importBucket === "maybe_ebay" && input.providerMessageIds.length === 0) {
        return json(req, 400, {
          ok: false,
          error: "maybe_ebay_requires_selected_message_ids",
          outlook_mutation_performed: false,
          classification_created: 0,
          drafts_created: 0,
        });
      }
      if (input.mode === "sync_import_approved" && input.importBucket === "not_ebay" && input.providerMessageIds.length === 0) {
        return json(req, 400, {
          ok: false,
          error: "bulk_not_ebay_import_not_allowed",
          outlook_mutation_performed: false,
          classification_created: 0,
          drafts_created: 0,
        });
      }

      let refreshToken = "";
      try {
        refreshToken = await decryptRefreshToken(model.secret);
      } catch {
        throw new SyncError("token_refresh_failed", {
          phase: "token_decrypt",
          connectionId,
          mailboxId,
          folderId,
          status: 401,
        });
      }

      const refreshedToken = await exchangeRefreshToken(refreshToken, connectionId);
      if (input.mode === "sync_import_approved") {
        if (refreshedToken.refreshToken) {
          await rotateRefreshToken(supabase, connectionId, refreshedToken.refreshToken, refreshedToken.refreshTokenExpiresIn);
        }
        await updateConnectionHealth(supabase, connectionId, {
          status: "connected",
          access_token_expires_at: accessTokenExpiry(refreshedToken.expiresIn),
          last_error_code: null,
          last_error_at: null,
        });
      }

      const previewInput = previewInputFrom(input);
      const previewPayload = await fetchPreviewMessages(previewMessagesUrl(model.folder.provider_folder_id, previewInput), refreshedToken.accessToken, {
        connectionId,
        mailboxId,
        folderId,
      });
      const previewMessages = (previewPayload.value || []).filter((message) => Boolean(message.id));
      const existingMatches = await loadExistingPreviewMatches(supabase, mailboxId, previewMessages);
      const { rows, bucketSummary, senderDomainSummary, alreadyImportedCount } = buildPreviewRows(previewMessages, existingMatches);

      if (input.mode === "sync_preview") {
        const messages = input.bucketMode === "ebay_only"
        ? rows.filter((row) => row.bucket !== "not_ebay")
        : rows;

        console.log("[microsoft-email-sync] preview completed", {
          phase: "sync_preview_complete",
          mailbox_id: mailboxId,
          folder_id: folderId,
          messages_previewed: previewMessages.length,
          messages_returned: messages.length,
          likely_ebay: bucketSummary.likely_ebay,
          maybe_ebay: bucketSummary.maybe_ebay,
          not_ebay: bucketSummary.not_ebay,
          already_imported: alreadyImportedCount,
        });

        return json(req, 200, {
          ok: true,
          mode: "sync_preview",
          folder: input.folder,
          limit: input.limit,
          daysBack: input.daysBack,
          bucketMode: input.bucketMode,
          caps: {
            max_limit: PREVIEW_MAX_LIMIT,
            max_daysBack: PREVIEW_MAX_DAYS_BACK,
          },
          graph_fields: PREVIEW_MESSAGE_SELECT.split(","),
          bucket_summary: bucketSummary,
          sender_domain_summary: senderDomainSummary,
          already_imported_summary: {
            imported: alreadyImportedCount,
            not_imported: Math.max(previewMessages.length - alreadyImportedCount, 0),
          },
          messages_previewed: previewMessages.length,
          messages_returned: messages.length,
          messages,
        });
      }

      const selectedIds = new Set(input.providerMessageIds);
      const explicitSelection = selectedIds.size > 0;
      const skippedReasons: Record<string, number> = {};
      const messages: Array<{
        provider_message_id: string | null;
        message_id: string | null;
        bucket: EbayBucket | null;
        import_status: "imported" | "already_imported" | "skipped";
        reason_codes: string[];
      }> = [];
      let importedCount = 0;
      let alreadyImportedImportCount = 0;
      let skippedCount = 0;
      const importedMessageIds: string[] = [];

      for (const row of rows) {
        const providerMessageId = row.provider_message_id;
        const selected = providerMessageId ? selectedIds.has(providerMessageId) : false;
        const eligible = explicitSelection ? selected : row.bucket === input.importBucket;
        if (!eligible) continue;

        if (!providerMessageId) {
          skippedCount += 1;
          incrementReason(skippedReasons, "missing_provider_message_id");
          messages.push({
            provider_message_id: null,
            message_id: null,
            bucket: row.bucket,
            import_status: "skipped",
            reason_codes: ["missing_provider_message_id"],
          });
          continue;
        }

        if (!explicitSelection && row.bucket !== "likely_ebay") {
          skippedCount += 1;
          incrementReason(skippedReasons, row.bucket);
          messages.push({
            provider_message_id: providerMessageId,
            message_id: null,
            bucket: row.bucket,
            import_status: "skipped",
            reason_codes: [`bulk_${row.bucket}_not_allowed`],
          });
          continue;
        }

        if (row.already_imported) {
          alreadyImportedImportCount += 1;
          messages.push({
            provider_message_id: providerMessageId,
            message_id: row.existing_message_id,
            bucket: row.bucket,
            import_status: "already_imported",
            reason_codes: ["already_imported"],
          });
          continue;
        }

        const fullMessage = await fetchFullMessage(providerMessageId, refreshedToken.accessToken, {
          connectionId,
          mailboxId,
          folderId,
        });
        const result = await upsertMessage(supabase, mailboxId, folderId, fullMessage);
        await replaceRecipients(supabase, result.messageId, fullMessage);
        await upsertBody(supabase, result.messageId, fullMessage);
        importedCount += 1;
        importedMessageIds.push(result.messageId);
        messages.push({
          provider_message_id: providerMessageId,
          message_id: result.messageId,
          bucket: row.bucket,
          import_status: "imported",
          reason_codes: row.reason_codes,
        });
      }

      if (explicitSelection) {
        const previewIds = new Set(rows.map((row) => row.provider_message_id).filter(Boolean) as string[]);
        for (const providerMessageId of selectedIds) {
          if (previewIds.has(providerMessageId)) continue;
          skippedCount += 1;
          incrementReason(skippedReasons, "not_in_preview");
          messages.push({
            provider_message_id: providerMessageId,
            message_id: null,
            bucket: null,
            import_status: "skipped",
            reason_codes: ["not_in_current_preview_scope"],
          });
        }
      } else if (input.importBucket === "likely_ebay") {
        const notEligibleCount = rows.filter((row) => row.bucket !== "likely_ebay").length;
        if (notEligibleCount > 0) {
          skippedCount += notEligibleCount;
          for (const row of rows.filter((candidate) => candidate.bucket !== "likely_ebay")) {
            incrementReason(skippedReasons, row.bucket);
          }
        }
      }

      const eventPayload = {
        mode: "sync_import_approved",
        source: input.source,
        requested_limit: input.limit,
        requested_daysBack: input.daysBack,
        import_bucket: input.importBucket,
        selected_count: selectedIds.size,
        imported_count: importedCount,
        skipped_already_imported_count: alreadyImportedImportCount,
        skipped_not_eligible_count: skippedCount,
        skipped_reasons: skippedReasons,
        classification_created: 0,
        drafts_created: 0,
        duration_ms: Date.now() - operationStartedAt,
        outlook_mutation_performed: false,
        sync_checkpoint_updated: false,
      };
      const auditEvent = await insertImportOperationalEvent(supabase, {
        mailboxId,
        messageIds: importedMessageIds,
        initiatedBy: admin.userId,
        initiatedByEmail: admin.email,
        payload: eventPayload,
      });

      console.log("[microsoft-email-sync] approved import completed", {
        phase: "sync_import_approved_complete",
        mailbox_id: mailboxId,
        folder_id: folderId,
        imported_count: importedCount,
        already_imported_count: alreadyImportedImportCount,
        skipped_count: skippedCount,
      });

      return json(req, 200, {
        ok: true,
        mode: "sync_import_approved",
        caps: {
          max_import_batch: MAX_IMPORT_BATCH,
        },
        imported_count: importedCount,
        already_imported_count: alreadyImportedImportCount,
        skipped_count: skippedCount,
        skipped_reasons: skippedReasons,
        classification_created: 0,
        drafts_created: 0,
        outlook_mutation_performed: false,
        sync_checkpoint_updated: false,
        operation_event_id: auditEvent?.id || null,
        messages,
      });
    }

    syncRunId = await createSyncRun(supabase, {
      mailboxId,
      folderId,
      syncStateId,
      mode: input.mode,
      startedBy: admin.userId,
    });

    await updateSyncState(supabase, syncStateId, {
      status: "syncing",
      last_attempted_sync_at: new Date().toISOString(),
      last_error_code: null,
      last_error_at: null,
    });

    let refreshToken = "";
    try {
      refreshToken = await decryptRefreshToken(model.secret);
    } catch {
      await markConnectionFailure(supabase, connectionId, "reconnect_required", "token_refresh_failed");
      throw new SyncError("token_refresh_failed", {
        phase: "token_decrypt",
        connectionId,
        mailboxId,
        folderId,
        syncRunId,
        status: 401,
      });
    }

    let refreshedToken: TokenRefreshResult;
    try {
      refreshedToken = await exchangeRefreshToken(refreshToken, connectionId);
    } catch (error) {
      const safe = safeError(error);
      await markConnectionFailure(supabase, connectionId, "reconnect_required", safe.code);
      throw safe;
    }

    if (refreshedToken.refreshToken) {
      await rotateRefreshToken(supabase, connectionId, refreshedToken.refreshToken, refreshedToken.refreshTokenExpiresIn);
    }

    await updateConnectionHealth(supabase, connectionId, {
      status: "connected",
      access_token_expires_at: accessTokenExpiry(refreshedToken.expiresIn),
      last_error_code: null,
      last_error_at: null,
    });

    const savedContinuationLink = input.mode === "manual_resync" ? null : continuationLink(model.syncState.metadata);
    let nextUrl = savedContinuationLink ||
      (input.mode === "incremental" && model.syncState.delta_link
        ? model.syncState.delta_link
        : initialDeltaUrl(model.folder.provider_folder_id, input.pageSize));
    let finalDeltaLink: string | null = null;

    for (let page = 0; page < input.maxPages && nextUrl; page += 1) {
      await updateSyncState(supabase, syncStateId, { last_page_started_at: new Date().toISOString() });
      const pagePayload = await fetchDeltaPage(nextUrl, refreshedToken.accessToken, {
        connectionId,
        mailboxId,
        folderId,
      });
      counters.graph_request_count += 1;
      counters.pages_fetched += 1;

      for (const message of pagePayload.value || []) {
        await processGraphMessage(supabase, mailboxId, folderId, message, counters);
      }

      await updateSyncState(supabase, syncStateId, { last_page_completed_at: new Date().toISOString() });
      finalDeltaLink = pagePayload["@odata.deltaLink"] || null;
      nextUrl = finalDeltaLink ? "" : pagePayload["@odata.nextLink"] || "";

      await updateSyncRun(supabase, syncRunId, counters);
    }

    const deltaCheckpointSaved = Boolean(finalDeltaLink);
    const partialSync = !deltaCheckpointSaved;
    const morePagesAvailable = Boolean(nextUrl && !finalDeltaLink);
    const deltaTokenHash = finalDeltaLink ? await sha256Hex(finalDeltaLink) : null;
    if (finalDeltaLink) {
      await updateSyncState(supabase, syncStateId, {
        delta_link: finalDeltaLink,
        delta_token_hash: deltaTokenHash,
        last_successful_sync_at: new Date().toISOString(),
        status: "idle",
        consecutive_error_count: 0,
        last_error_code: null,
        last_error_at: null,
        metadata: {
          ...withoutContinuation(model.syncState.metadata),
          last_delta_checkpoint_saved_at: new Date().toISOString(),
          resumed_from_continuation: Boolean(savedContinuationLink),
        },
      });
    } else if (morePagesAvailable) {
      await updateSyncState(supabase, syncStateId, {
        status: "syncing",
        ...(model.syncState.delta_link ? {} : { last_successful_sync_at: null }),
        last_error_code: null,
        last_error_at: null,
        metadata: {
          ...withoutContinuation(model.syncState.metadata),
          partial_sync: true,
          continuation_link: nextUrl,
          continuation_saved_at: new Date().toISOString(),
          pages_fetched_before_pause: counters.pages_fetched,
          more_pages_available: true,
          delta_checkpoint_saved: false,
          resumed_from_continuation: Boolean(savedContinuationLink),
        },
      });
    } else {
      await updateSyncState(supabase, syncStateId, {
        status: "syncing",
        ...(model.syncState.delta_link ? {} : { last_successful_sync_at: null }),
        last_error_code: "sync_incomplete_no_checkpoint",
        last_error_at: new Date().toISOString(),
        metadata: {
          ...withoutContinuation(model.syncState.metadata),
          partial_sync: true,
          more_pages_available: false,
          delta_checkpoint_saved: false,
          pages_fetched_before_pause: counters.pages_fetched,
          incomplete_reason: "missing_delta_or_next_link",
        },
      });
    }

    await supabase
      .from("email_mailboxes")
      .update({
        ...(finalDeltaLink ? { last_sync_at: new Date().toISOString() } : {}),
        status: "active",
        last_error_code: null,
        last_error_at: null,
      })
      .eq("id", mailboxId);

    await updateConnectionHealth(supabase, connectionId, {
      last_successful_check_at: new Date().toISOString(),
      last_error_code: null,
      last_error_at: null,
    });

    await updateSyncRun(supabase, syncRunId, {
      ...counters,
      status: "succeeded",
      completed_at: new Date().toISOString(),
      metadata: {
        function: "microsoft-email-sync",
        delta_checkpoint_saved: deltaCheckpointSaved,
        partial_sync: partialSync,
        more_pages_available: morePagesAvailable,
        page_cap_reached: morePagesAvailable,
        resumed_from_continuation: Boolean(savedContinuationLink),
      },
    });

    console.log("[microsoft-email-sync] completed", {
      phase: "sync_complete",
      mailbox_id: mailboxId,
      folder_id: folderId,
      sync_run_id: syncRunId,
      status: "succeeded",
      pages_fetched: counters.pages_fetched,
      messages_seen: counters.messages_seen,
    });

    return json(req, 200, {
      ok: true,
      mode: input.mode,
      mailbox_id: mailboxId,
      folder_id: folderId,
      sync_run_id: syncRunId,
      pages_fetched: counters.pages_fetched,
      messages_seen: counters.messages_seen,
      messages_inserted: counters.messages_inserted,
      messages_updated: counters.messages_updated,
      messages_deleted: counters.messages_deleted,
      attachments_seen: counters.attachments_seen,
      partial: partialSync,
      more_pages_available: morePagesAvailable,
      delta_checkpoint_saved: deltaCheckpointSaved,
    });
  } catch (error) {
    const safe = safeError(error);
    const statusForState = safe.code === "graph_delta_expired" ? "reset_required" : "error";
    console.error("[microsoft-email-sync] failed", safeLog(safe, counters));

    if (!isPreview && supabase && syncStateId) {
      await supabase
        .from("email_sync_states")
        .update({
          status: statusForState,
          last_error_code: safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code,
          last_error_at: new Date().toISOString(),
          consecutive_error_count: previousErrorCount + 1,
        })
        .eq("id", syncStateId);
    }

    if (!isPreview && supabase && syncRunId) {
      await updateSyncRun(supabase, syncRunId, {
        ...counters,
        status: "failed",
        completed_at: new Date().toISOString(),
        last_error_code: safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code,
        last_error_message: safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code,
      });
    }

    if (!isPreview && supabase && mailboxId) {
      await supabase
        .from("email_mailboxes")
        .update({
          last_error_code: safe.code,
          last_error_at: new Date().toISOString(),
        })
        .eq("id", mailboxId);
    }

    if (!isPreview && supabase && connectionId && ["token_refresh_failed", "missing_connection_secret"].includes(safe.code)) {
      await markConnectionFailure(supabase, connectionId, "reconnect_required", safe.code);
    } else if (!isPreview && supabase && connectionId && ["graph_delta_failed", "graph_delta_expired"].includes(safe.code)) {
      await markConnectionFailure(supabase, connectionId, "error", safe.code);
    }

    const responseCode = safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code;
    return json(req, safe.status, { ok: false, error: responseCode });
  }
});
