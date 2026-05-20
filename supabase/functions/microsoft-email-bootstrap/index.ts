import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_SCOPES = "offline_access Mail.Read User.Read";
const ACTIVE_CONNECTION_STATUSES = ["connected", "error", "reconnect_required"];

type ServiceClient = ReturnType<typeof createClient>;

type MailboxConnection = {
  id: string;
  mailbox_email: string;
  display_name: string | null;
  connected_by: string | null;
  status: string;
};

type MailboxSecret = {
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  refresh_token_key_version: string;
};

type TokenRefreshResult = {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
};

type GraphFolder = {
  id?: string;
  displayName?: string;
  parentFolderId?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
};

class BootstrapError extends Error {
  code: string;
  status: number;
  phase: string;
  connectionId?: string;
  mailboxId?: string;
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
      syncRunId?: string;
      microsoftStatus?: number;
      microsoftError?: string;
    } = {},
  ) {
    super(code);
    this.name = "BootstrapError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "bootstrap";
    this.connectionId = options.connectionId;
    this.mailboxId = options.mailboxId;
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
  if (!value) {
    throw new BootstrapError("configuration_error", { phase: "configuration" });
  }
  return value;
}

function serviceClient() {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceRoleKey, {
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
  if (!accessToken) return { ok: false as const, status: 401, error: "missing_authorization" };

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) return { ok: false as const, status: 401, error: "invalid_session" };

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) return { ok: false as const, status: 500, error: "employee_lookup_failed" };
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    return { ok: false as const, status: 403, error: "admin_required" };
  }

  return { ok: true as const, userId: user.id };
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
  const secret = requiredEnv("MICROSOFT_TOKEN_ENCRYPTION_KEY");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
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
  const encoded = new TextEncoder().encode(refreshToken);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
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

async function updateConnectionHealth(
  supabase: ServiceClient,
  connectionId: string,
  values: Record<string, unknown>,
) {
  const { error } = await supabase
    .from("microsoft_mailbox_connections")
    .update({
      ...values,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);

  if (error) {
    console.error("[microsoft-email-bootstrap] connection health update failed", {
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

async function loadActiveConnection(supabase: ServiceClient): Promise<MailboxConnection> {
  const { data, error } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id, mailbox_email, display_name, connected_by, status")
    .in("status", ACTIVE_CONNECTION_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(2);

  if (error) {
    throw new BootstrapError("connection_lookup_failed", { phase: "connection_lookup" });
  }
  if (!data?.length) {
    throw new BootstrapError("mailbox_not_connected", { status: 404, phase: "connection_lookup" });
  }
  if (data.length > 1) {
    throw new BootstrapError("multiple_active_connections", { status: 409, phase: "connection_lookup" });
  }

  return data[0] as MailboxConnection;
}

async function loadConnectionSecret(supabase: ServiceClient, connectionId: string) {
  const { data, error } = await supabase
    .from("microsoft_mailbox_connection_secrets")
    .select("refresh_token_ciphertext, refresh_token_iv, refresh_token_key_version")
    .eq("connection_id", connectionId)
    .maybeSingle();

  if (error) {
    throw new BootstrapError("connection_secret_lookup_failed", {
      phase: "secret_lookup",
      connectionId,
    });
  }
  if (!data) {
    await markConnectionFailure(supabase, connectionId, "reconnect_required", "missing_connection_secret");
    throw new BootstrapError("missing_connection_secret", {
      status: 401,
      phase: "secret_lookup",
      connectionId,
    });
  }

  return data as MailboxSecret;
}

async function exchangeRefreshToken(refreshToken: string, connectionId: string): Promise<TokenRefreshResult> {
  const clientId = requiredEnv("MICROSOFT_CLIENT_ID");
  const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
  const tenantId = requiredEnv("MICROSOFT_TENANT_ID");
  const authorityHost = Deno.env.get("MICROSOFT_AUTHORITY_HOST")?.trim() || DEFAULT_AUTHORITY_HOST;
  const scopes = Deno.env.get("MICROSOFT_GRAPH_SCOPES")?.trim() || DEFAULT_SCOPES;
  const tokenUrl = `${authorityHost.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("scope", scopes);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new BootstrapError("token_refresh_failed", {
      status: 401,
      phase: "token_refresh",
      connectionId,
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
    refreshTokenExpiresIn: Number.isFinite(refreshTokenExpiresIn) && refreshTokenExpiresIn > 0
      ? refreshTokenExpiresIn
      : undefined,
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

  if (error) {
    throw new BootstrapError("refresh_token_rotation_failed", {
      phase: "token_rotation",
      connectionId,
    });
  }
}

async function ensureEmailMailbox(supabase: ServiceClient, connection: MailboxConnection) {
  const values = {
    provider: "microsoft",
    microsoft_connection_id: connection.id,
    mailbox_email: connection.mailbox_email,
    display_name: connection.display_name,
    status: "active",
    sync_enabled: true,
    connected_by: connection.connected_by,
    last_error_code: null,
    last_error_at: null,
    metadata: {
      bootstrap_source: "microsoft-email-bootstrap",
      microsoft_connection_status: connection.status,
    },
  };

  const { data: existing, error: lookupError } = await supabase
    .from("email_mailboxes")
    .select("id")
    .eq("microsoft_connection_id", connection.id)
    .maybeSingle();

  if (lookupError) {
    throw new BootstrapError("mailbox_lookup_failed", {
      phase: "mailbox_lookup",
      connectionId: connection.id,
    });
  }

  if (existing?.id) {
    const { data, error } = await supabase
      .from("email_mailboxes")
      .update(values)
      .eq("id", existing.id)
      .select("id")
      .single();

    if (error || !data?.id) {
      throw new BootstrapError("mailbox_upsert_failed", {
        phase: "mailbox_upsert",
        connectionId: connection.id,
      });
    }

    return String(data.id);
  }

  const { data, error } = await supabase
    .from("email_mailboxes")
    .insert(values)
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new BootstrapError("mailbox_upsert_failed", {
      phase: "mailbox_upsert",
      connectionId: connection.id,
    });
  }

  return String(data.id);
}

async function createBootstrapRun(supabase: ServiceClient, mailboxId: string, startedBy: string) {
  const { data, error } = await supabase
    .from("email_sync_runs")
    .insert({
      mailbox_id: mailboxId,
      run_type: "bootstrap",
      status: "running",
      started_by: startedBy,
      trigger_source: "microsoft-email-bootstrap",
      metadata: { scope: "folders_and_sync_states" },
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new BootstrapError("sync_run_insert_failed", {
      phase: "sync_run_insert",
      mailboxId,
    });
  }

  return String(data.id);
}

async function finishBootstrapRun(
  supabase: ServiceClient,
  runId: string,
  status: "succeeded" | "failed",
  values: Record<string, unknown>,
) {
  const { error } = await supabase
    .from("email_sync_runs")
    .update({
      ...values,
      status,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    console.error("[microsoft-email-bootstrap] sync run update failed", {
      phase: "sync_run_update",
      runId,
      status,
    });
  }
}

async function fetchInboxFolder(accessToken: string, connectionId: string): Promise<GraphFolder> {
  const graphBaseUrl = Deno.env.get("MICROSOFT_GRAPH_BASE_URL")?.trim() || DEFAULT_GRAPH_BASE_URL;
  const url = new URL(`${graphBaseUrl.replace(/\/+$/, "")}/me/mailFolders/inbox`);
  url.searchParams.set("$select", "id,displayName,parentFolderId,totalItemCount,unreadItemCount");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id) {
    throw new BootstrapError("graph_folder_failed", {
      status: response.status >= 500 ? 502 : response.status,
      phase: "graph_folder",
      connectionId,
      microsoftStatus: response.status,
      microsoftError: typeof payload?.error?.code === "string" ? payload.error.code : undefined,
    });
  }

  return payload as GraphFolder;
}

async function upsertInboxFolder(supabase: ServiceClient, mailboxId: string, folder: GraphFolder) {
  const { data, error } = await supabase
    .from("email_folders")
    .upsert(
      {
        mailbox_id: mailboxId,
        provider_folder_id: String(folder.id),
        well_known_name: "inbox",
        display_name: typeof folder.displayName === "string" ? folder.displayName : "Inbox",
        parent_provider_folder_id: typeof folder.parentFolderId === "string" ? folder.parentFolderId : null,
        total_item_count: Number.isFinite(Number(folder.totalItemCount)) ? Number(folder.totalItemCount) : null,
        unread_item_count: Number.isFinite(Number(folder.unreadItemCount)) ? Number(folder.unreadItemCount) : null,
        is_sync_enabled: true,
        metadata: {
          bootstrap_source: "microsoft-email-bootstrap",
          graph_well_known_name: "inbox",
        },
      },
      { onConflict: "mailbox_id,provider_folder_id" },
    )
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new BootstrapError("folder_upsert_failed", {
      phase: "folder_upsert",
      mailboxId,
    });
  }

  return String(data.id);
}

async function upsertSyncState(supabase: ServiceClient, mailboxId: string, folderId: string) {
  const { data, error } = await supabase
    .from("email_sync_states")
    .upsert(
      {
        mailbox_id: mailboxId,
        folder_id: folderId,
        sync_scope: "folder_messages",
        status: "never_synced",
        last_error_code: null,
        last_error_at: null,
        metadata: {
          bootstrap_source: "microsoft-email-bootstrap",
        },
      },
      { onConflict: "mailbox_id,folder_id,sync_scope" },
    )
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new BootstrapError("sync_state_upsert_failed", {
      phase: "sync_state_upsert",
      mailboxId,
    });
  }

  return String(data.id);
}

function safeError(error: unknown) {
  if (error instanceof BootstrapError) return error;
  return new BootstrapError("email_bootstrap_failed");
}

function safeLog(error: BootstrapError) {
  return {
    phase: error.phase,
    error: error.code,
    connectionId: error.connectionId,
    mailboxId: error.mailboxId,
    syncRunId: error.syncRunId,
    status: error.microsoftStatus,
    microsoftError: error.microsoftError,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  let supabase: ServiceClient | null = null;
  let mailboxId: string | undefined;
  let syncRunId: string | undefined;

  try {
    supabase = serviceClient();
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const connection = await loadActiveConnection(supabase);

    mailboxId = await ensureEmailMailbox(supabase, connection);
    syncRunId = await createBootstrapRun(supabase, mailboxId, admin.userId);

    const secret = await loadConnectionSecret(supabase, connection.id);
    let refreshToken = "";
    try {
      refreshToken = await decryptRefreshToken(secret);
    } catch {
      await markConnectionFailure(supabase, connection.id, "reconnect_required", "refresh_token_decrypt_failed");
      throw new BootstrapError("refresh_token_decrypt_failed", {
        status: 401,
        phase: "token_decrypt",
        connectionId: connection.id,
        mailboxId,
        syncRunId,
      });
    }

    let refreshedToken: TokenRefreshResult;
    try {
      refreshedToken = await exchangeRefreshToken(refreshToken, connection.id);
    } catch (error) {
      const safe = safeError(error);
      await markConnectionFailure(supabase, connection.id, "reconnect_required", safe.code);
      throw safe;
    }

    if (refreshedToken.refreshToken) {
      try {
        await rotateRefreshToken(supabase, connection.id, refreshedToken.refreshToken, refreshedToken.refreshTokenExpiresIn);
      } catch (error) {
        const safe = safeError(error);
        await markConnectionFailure(supabase, connection.id, "reconnect_required", safe.code);
        throw safe;
      }
    }

    let folder: GraphFolder;
    try {
      folder = await fetchInboxFolder(refreshedToken.accessToken, connection.id);
    } catch (error) {
      const safe = safeError(error);
      await markConnectionFailure(supabase, connection.id, "error", safe.code);
      throw safe;
    }

    const folderId = await upsertInboxFolder(supabase, mailboxId, folder);
    const syncStateId = await upsertSyncState(supabase, mailboxId, folderId);

    await updateConnectionHealth(supabase, connection.id, {
      status: "connected",
      access_token_expires_at: accessTokenExpiry(refreshedToken.expiresIn),
      last_successful_check_at: new Date().toISOString(),
      last_error_code: null,
      last_error_at: null,
    });

    await supabase
      .from("email_mailboxes")
      .update({
        status: "active",
        last_error_code: null,
        last_error_at: null,
      })
      .eq("id", mailboxId);

    await finishBootstrapRun(supabase, syncRunId, "succeeded", {
      folder_id: folderId,
      sync_state_id: syncStateId,
      graph_request_count: 1,
      pages_fetched: 0,
      metadata: {
        scope: "folders_and_sync_states",
        folders: ["inbox"],
        sync_state_id: syncStateId,
      },
    });

    console.log("[microsoft-email-bootstrap] completed", {
      phase: "bootstrap",
      connectionId: connection.id,
      mailboxId,
      folderCount: 1,
      syncStateCount: 1,
    });

    return json(req, 200, {
      ok: true,
      mailbox_id: mailboxId,
      folders_upserted: 1,
      sync_states_upserted: 1,
    });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-email-bootstrap] failed", safeLog(safe));

    if (supabase && syncRunId) {
      await finishBootstrapRun(supabase, syncRunId, "failed", {
        last_error_code: safe.code,
        last_error_message: safe.code,
        metadata: {
          scope: "folders_and_sync_states",
          failed_phase: safe.phase,
        },
      });
    }
    if (supabase && mailboxId) {
      await supabase
        .from("email_mailboxes")
        .update({
          status: "error",
          last_error_code: safe.code,
          last_error_at: new Date().toISOString(),
        })
        .eq("id", mailboxId);
    }

    return json(req, safe.status, { ok: false, error: safe.code });
  }
});
