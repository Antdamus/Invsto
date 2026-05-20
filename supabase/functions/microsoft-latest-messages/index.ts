import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_SCOPES = "offline_access Mail.Read User.Read";
const COOKIE_NAME = "og_ms_graph_poc";
const ACTIVE_CONNECTION_STATUSES = ["connected", "error", "reconnect_required"];

type ServiceClient = ReturnType<typeof createClient>;

type MailboxConnection = {
  id: string;
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

class LatestMessagesError extends Error {
  code: string;
  status: number;
  phase: string;
  connectionId?: string;
  microsoftStatus?: number;
  microsoftError?: string;

  constructor(
    code: string,
    options: {
      status?: number;
      phase?: string;
      connectionId?: string;
      microsoftStatus?: number;
      microsoftError?: string;
    } = {},
  ) {
    super(code);
    this.name = "LatestMessagesError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "latest_messages";
    this.connectionId = options.connectionId;
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    throw new LatestMessagesError("configuration_error", {
      phase: "configuration",
    });
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

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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

async function cookieDecryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptPayload<T>(value: string, secret: string): Promise<T> {
  const [ivText, cipherText] = value.split(".");
  if (!ivText || !cipherText) throw new Error("invalid_mailbox_cookie");
  const key = await cookieDecryptionKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(ivText) },
    key,
    decodeBase64Url(cipherText),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
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

function parseCookies(req: Request) {
  const header = req.headers.get("Cookie") || "";
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    cookies.set(name, rest.join("="));
  }
  return cookies;
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

function sanitizeMessage(message: any) {
  const email = message?.from?.emailAddress;
  const name = String(email?.name || "").trim();
  const address = String(email?.address || "").trim();
  return {
    id: String(message?.id || ""),
    subject: String(message?.subject || ""),
    from: name && address ? `${name} <${address}>` : name || address,
    receivedDateTime: String(message?.receivedDateTime || ""),
    bodyPreview: String(message?.bodyPreview || ""),
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
    console.error("[microsoft-latest-messages] connection health update failed", {
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

async function loadActiveConnection(supabase: ServiceClient): Promise<MailboxConnection | null> {
  const { data, error } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id, status")
    .in("status", ACTIVE_CONNECTION_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(2);

  if (error) {
    throw new LatestMessagesError("connection_lookup_failed", {
      phase: "connection_lookup",
    });
  }

  if (!data?.length) return null;
  if (data.length > 1) {
    throw new LatestMessagesError("multiple_active_connections", {
      status: 409,
      phase: "connection_lookup",
    });
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
    throw new LatestMessagesError("connection_secret_lookup_failed", {
      phase: "secret_lookup",
      connectionId,
    });
  }

  if (!data) {
    await markConnectionFailure(supabase, connectionId, "reconnect_required", "missing_connection_secret");
    throw new LatestMessagesError("missing_connection_secret", {
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
    throw new LatestMessagesError("token_refresh_failed", {
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
    throw new LatestMessagesError("refresh_token_rotation_failed", {
      phase: "token_rotation",
      connectionId,
    });
  }
}

async function fetchLatestMessages(accessToken: string, connectionId?: string) {
  const graphBaseUrl = Deno.env.get("MICROSOFT_GRAPH_BASE_URL")?.trim() || DEFAULT_GRAPH_BASE_URL;
  const url = new URL(`${graphBaseUrl.replace(/\/+$/, "")}/me/messages`);
  url.searchParams.set("$top", "10");
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview");
  url.searchParams.set("$orderby", "receivedDateTime desc");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new LatestMessagesError("graph_messages_failed", {
      status: response.status >= 500 ? 502 : response.status,
      phase: "graph_messages",
      connectionId,
      microsoftStatus: response.status,
      microsoftError: typeof payload?.error?.code === "string" ? payload.error.code : undefined,
    });
  }
  return Array.isArray(payload?.value) ? payload.value.map(sanitizeMessage) : [];
}

async function loadMessagesFromProofCookie(req: Request, adminUserId: string) {
  const encryptedToken = parseCookies(req).get(COOKIE_NAME);
  if (!encryptedToken) {
    throw new LatestMessagesError("mailbox_not_connected", {
      status: 401,
      phase: "proof_cookie",
    });
  }

  const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
  const tokenPayload = await decryptPayload<{ accessToken?: string; expiresAt?: number; sub?: string }>(
    encryptedToken,
    clientSecret,
  );
  if (!tokenPayload.accessToken || !tokenPayload.expiresAt || tokenPayload.expiresAt < Date.now()) {
    throw new LatestMessagesError("outlook_connection_expired", {
      status: 401,
      phase: "proof_cookie",
    });
  }
  if (tokenPayload.sub && tokenPayload.sub !== adminUserId) {
    throw new LatestMessagesError("outlook_connection_user_mismatch", {
      status: 403,
      phase: "proof_cookie",
    });
  }

  const messages = await fetchLatestMessages(tokenPayload.accessToken);
  return messages;
}

function safeError(error: unknown) {
  if (error instanceof LatestMessagesError) return error;
  if (error instanceof Error && error.message.startsWith("missing_env:")) {
    return new LatestMessagesError("configuration_error", { phase: "configuration" });
  }
  return new LatestMessagesError("latest_messages_failed");
}

function safeLog(error: LatestMessagesError) {
  return {
    phase: error.phase,
    error: error.code,
    connectionId: error.connectionId,
    status: error.microsoftStatus,
    microsoftError: error.microsoftError,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (!["GET", "POST"].includes(req.method)) return json(req, 405, { ok: false, error: "method_not_allowed" });

  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const supabase = serviceClient();
    const connection = await loadActiveConnection(supabase);
    if (!connection) {
      const messages = await loadMessagesFromProofCookie(req, admin.userId);
      console.log("[microsoft-latest-messages] messages loaded", {
        phase: "proof_cookie",
        userId: admin.userId,
        messageCount: messages.length,
      });
      return json(req, 200, { ok: true, messages, source: "proof_cookie" });
    }

    const secret = await loadConnectionSecret(supabase, connection.id);
    let refreshToken = "";
    try {
      refreshToken = await decryptRefreshToken(secret);
    } catch {
      await markConnectionFailure(supabase, connection.id, "reconnect_required", "refresh_token_decrypt_failed");
      throw new LatestMessagesError("refresh_token_decrypt_failed", {
        status: 401,
        phase: "token_decrypt",
        connectionId: connection.id,
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

    let messages: ReturnType<typeof sanitizeMessage>[];
    try {
      messages = await fetchLatestMessages(refreshedToken.accessToken, connection.id);
    } catch (error) {
      const safe = safeError(error);
      await markConnectionFailure(supabase, connection.id, "error", safe.code);
      throw safe;
    }

    await updateConnectionHealth(supabase, connection.id, {
      status: "connected",
      access_token_expires_at: accessTokenExpiry(refreshedToken.expiresIn),
      last_successful_check_at: new Date().toISOString(),
      last_error_code: null,
      last_error_at: null,
    });

    console.log("[microsoft-latest-messages] messages loaded", {
      phase: "persisted_connection",
      userId: admin.userId,
      connectionId: connection.id,
      messageCount: messages.length,
    });

    return json(req, 200, { ok: true, messages, source: "persisted_connection" });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-latest-messages] failed", safeLog(safe));
    return json(req, safe.status, { ok: false, error: safe.code });
  }
});
