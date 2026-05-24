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
const IMPORT_APPROVAL_CONFIRMATION = "IMPORT_PREVIEW_APPROVED";

type ServiceClient = ReturnType<typeof createClient>;
type DurableSyncMode = typeof DURABLE_SYNC_MODES[number];
type BucketMode = "ebay_only" | "all";

type MailboxConnection = {
  id: string;
  status: string;
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

type RequestInput = SyncInput | PreviewInput | ImportApprovedInput;

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
    const rawLimit = Number(body?.limit);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : PREVIEW_DEFAULT_LIMIT, 1), PREVIEW_MAX_LIMIT);
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
      ? [...new Set(body.providerMessageIds.map((value: unknown) => graphText(value)).filter(Boolean) as string[])].slice(0, PREVIEW_MAX_LIMIT)
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
    isPreview = input.mode === "sync_preview" || input.mode === "sync_import_approved";
    const model = await loadModel(supabase);
    mailboxId = model.mailbox.id;
    folderId = model.folder.id;
    syncStateId = model.syncState.id;
    connectionId = model.connection.id;
    previousErrorCount = Number(model.syncState.consecutive_error_count || 0);

    if (input.mode === "sync_preview" || input.mode === "sync_import_approved") {
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
