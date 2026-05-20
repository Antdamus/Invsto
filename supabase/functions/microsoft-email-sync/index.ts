import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_SCOPES = "offline_access Mail.Read User.Read";
const ACTIVE_CONNECTION_STATUSES = ["connected", "error", "reconnect_required"];
const SUPPORTED_MODES = ["initial_backfill", "incremental", "manual_resync"] as const;
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

type ServiceClient = ReturnType<typeof createClient>;
type SyncMode = typeof SUPPORTED_MODES[number];

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
};

type TokenRefreshResult = {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
};

type SyncInput = {
  mode: SyncMode;
  folder: "inbox";
  maxPages: number;
  pageSize: number;
};

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

  return { ok: true as const, userId: user.id };
}

async function parseInput(req: Request): Promise<SyncInput> {
  const body = await req.json().catch(() => ({}));
  const requestedMode = typeof body?.mode === "string" ? body.mode : "";
  const mode = SUPPORTED_MODES.includes(requestedMode as SyncMode) ? requestedMode as SyncMode : "initial_backfill";
  const folder = String(body?.folder || "inbox").toLowerCase();
  if (folder !== "inbox") {
    throw new SyncError("missing_folder", { status: 400, phase: "input" });
  }

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
    .select("id, delta_link, consecutive_error_count")
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

async function createSyncRun(
  supabase: ServiceClient,
  values: { mailboxId: string; folderId: string; syncStateId: string; mode: SyncMode; startedBy: string },
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
  const counters = blankCounters();

  try {
    supabase = serviceClient();
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const input = await parseInput(req);
    const model = await loadModel(supabase);
    mailboxId = model.mailbox.id;
    folderId = model.folder.id;
    syncStateId = model.syncState.id;
    connectionId = model.connection.id;
    previousErrorCount = Number(model.syncState.consecutive_error_count || 0);

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

    let nextUrl = input.mode === "incremental" && model.syncState.delta_link
      ? model.syncState.delta_link
      : initialDeltaUrl(model.folder.provider_folder_id, input.pageSize);
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

    const deltaTokenHash = finalDeltaLink ? await sha256Hex(finalDeltaLink) : null;
    await updateSyncState(supabase, syncStateId, {
      ...(finalDeltaLink ? {
        delta_link: finalDeltaLink,
        delta_token_hash: deltaTokenHash,
        last_successful_sync_at: new Date().toISOString(),
      } : {}),
      status: "idle",
      consecutive_error_count: 0,
      last_error_code: null,
      last_error_at: null,
    });

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
        delta_checkpoint_saved: Boolean(finalDeltaLink),
        page_cap_reached: Boolean(nextUrl),
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
      delta_checkpoint_saved: Boolean(finalDeltaLink),
    });
  } catch (error) {
    const safe = safeError(error);
    const statusForState = safe.code === "graph_delta_expired" ? "reset_required" : "error";
    console.error("[microsoft-email-sync] failed", safeLog(safe, counters));

    if (supabase && syncStateId) {
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

    if (supabase && syncRunId) {
      await updateSyncRun(supabase, syncRunId, {
        ...counters,
        status: "failed",
        completed_at: new Date().toISOString(),
        last_error_code: safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code,
        last_error_message: safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code,
      });
    }

    if (supabase && mailboxId) {
      await supabase
        .from("email_mailboxes")
        .update({
          last_error_code: safe.code,
          last_error_at: new Date().toISOString(),
        })
        .eq("id", mailboxId);
    }

    if (supabase && connectionId && ["token_refresh_failed", "missing_connection_secret"].includes(safe.code)) {
      await markConnectionFailure(supabase, connectionId, "reconnect_required", safe.code);
    } else if (supabase && connectionId && ["graph_delta_failed", "graph_delta_expired"].includes(safe.code)) {
      await markConnectionFailure(supabase, connectionId, "error", safe.code);
    }

    const responseCode = safe.code === "graph_delta_expired" ? "delta_reset_required" : safe.code;
    return json(req, safe.status, { ok: false, error: responseCode });
  }
});
