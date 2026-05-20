import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const COOKIE_NAME = "og_ms_graph_poc";
const DEFAULT_LOCAL_APP_URL = "http://127.0.0.1:3000/email-triage.html";

class CallbackError extends Error {
  reason: string;
  phase: string;
  status?: number;
  microsoftError?: string;
  microsoftErrorCodes?: string;

  constructor(
    reason: string,
    message: string,
    options: {
      phase?: string;
      status?: number;
      microsoftError?: string;
      microsoftErrorCodes?: string;
    } = {},
  ) {
    super(message);
    this.name = "CallbackError";
    this.reason = reason;
    this.phase = options.phase || "callback";
    this.status = options.status;
    this.microsoftError = options.microsoftError;
    this.microsoftErrorCodes = options.microsoftErrorCodes;
  }
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new CallbackError("missing_env", `${name} is not configured`, {
      phase: "configuration",
    });
  }
  return value;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

type VerifiedState = {
  sub: string;
  exp: number;
  returnTo?: string;
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  refreshTokenExpiresIn?: number;
};

type GraphProfile = {
  id: string;
  mail?: string;
  userPrincipalName?: string;
  displayName?: string;
};

async function verifyState(state: string, secret: string): Promise<VerifiedState> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new CallbackError("invalid_state", "OAuth state is malformed", { phase: "state" });
  const expected = await hmacSha256(secret, payload);
  if (expected !== signature) {
    throw new CallbackError("invalid_state", "OAuth state signature did not match", { phase: "state" });
  }

  const decoded = decodeJson<{ sub?: string; exp?: number; returnTo?: string }>(payload);
  const now = Math.floor(Date.now() / 1000);
  if (!decoded.sub || !decoded.exp || decoded.exp < now) {
    throw new CallbackError("invalid_state", "OAuth state is missing or expired", { phase: "state" });
  }
  return decoded as VerifiedState;
}

function serviceClient() {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function verifyAdminUser(userId: string) {
  const supabase = serviceClient();

  const { data: employee, error } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new CallbackError("employee_lookup_failed", "Could not verify callback admin user", {
      phase: "admin_check",
    });
  }
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new CallbackError("admin_required", "Callback user is not an active admin", {
      phase: "admin_check",
    });
  }
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptPayload(payload: Record<string, unknown>, secret: string) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`;
}

function tokenEncryptionSecret() {
  const value = Deno.env.get("MICROSOFT_TOKEN_ENCRYPTION_KEY")?.trim();
  if (!value) {
    throw new CallbackError("missing_token_encryption_key", "Microsoft token encryption key is not configured", {
      phase: "configuration",
    });
  }
  return value;
}

function tokenKeyVersion() {
  return Deno.env.get("MICROSOFT_TOKEN_ENCRYPTION_KEY_VERSION")?.trim() || "v1";
}

async function tokenEncryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function encryptRefreshToken(refreshToken: string) {
  const key = await tokenEncryptionKey(tokenEncryptionSecret());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(refreshToken);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: base64(new Uint8Array(cipher)),
    iv: base64(iv),
    keyVersion: tokenKeyVersion(),
  };
}

function cookieAttributes(req: Request, maxAge: number) {
  const host = new URL(req.url).hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const sameSite = isLocal ? "SameSite=Lax" : "SameSite=None; Secure";
  return `Path=/; Max-Age=${maxAge}; HttpOnly; ${sameSite}`;
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

async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const clientId = requiredEnv("MICROSOFT_CLIENT_ID");
  const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
  const tenantId = requiredEnv("MICROSOFT_TENANT_ID");
  const redirectUri = requiredEnv("MICROSOFT_REDIRECT_URI");
  const authorityHost = Deno.env.get("MICROSOFT_AUTHORITY_HOST")?.trim() || DEFAULT_AUTHORITY_HOST;
  const tokenUrl = `${authorityHost.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("grant_type", "authorization_code");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new CallbackError("token_exchange_failed", "Microsoft token exchange failed", {
      phase: "token_exchange",
      status: response.status,
      microsoftError: typeof payload?.error === "string" ? payload.error : undefined,
      microsoftErrorCodes: Array.isArray(payload?.error_codes) ? payload.error_codes.join(",") : undefined,
    });
  }

  if (!payload?.refresh_token) {
    throw new CallbackError("missing_refresh_token", "Microsoft token response did not include a refresh token", {
      phase: "token_exchange",
      status: response.status,
    });
  }

  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new CallbackError("token_exchange_failed", "Microsoft token response did not include a valid expiry", {
      phase: "token_exchange",
      status: response.status,
    });
  }

  const refreshTokenExpiresIn = Number(payload.refresh_token_expires_in);
  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token),
    expiresIn,
    scope: String(payload.scope || ""),
    refreshTokenExpiresIn: Number.isFinite(refreshTokenExpiresIn) && refreshTokenExpiresIn > 0
      ? refreshTokenExpiresIn
      : undefined,
  };
}

async function fetchGraphProfile(accessToken: string): Promise<GraphProfile> {
  const graphBaseUrl = Deno.env.get("MICROSOFT_GRAPH_BASE_URL")?.trim() || DEFAULT_GRAPH_BASE_URL;
  const url = new URL(`${graphBaseUrl.replace(/\/+$/, "")}/me`);
  url.searchParams.set("$select", "id,mail,userPrincipalName,displayName");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CallbackError("graph_me_failed", "Microsoft Graph profile request failed", {
      phase: "graph_me",
      status: response.status,
      microsoftError: typeof payload?.error?.code === "string" ? payload.error.code : undefined,
    });
  }

  const id = String(payload?.id || "").trim();
  const mail = String(payload?.mail || "").trim();
  const userPrincipalName = String(payload?.userPrincipalName || "").trim();
  const displayName = String(payload?.displayName || "").trim();
  if (!id || (!mail && !userPrincipalName)) {
    throw new CallbackError("graph_me_failed", "Microsoft Graph profile did not include a mailbox identity", {
      phase: "graph_me",
      status: response.status,
    });
  }

  return {
    id,
    mail: mail || undefined,
    userPrincipalName: userPrincipalName || undefined,
    displayName: displayName || undefined,
  };
}

function scopesFromToken(tokenScope: string) {
  const fallbackScopes = Deno.env.get("MICROSOFT_GRAPH_SCOPES")?.trim() || "";
  const source = tokenScope.trim() || fallbackScopes;
  return source.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

function isoAfterSeconds(seconds?: number) {
  if (!seconds) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function persistConnection(
  userId: string,
  token: TokenResponse,
  profile: GraphProfile,
) {
  const supabase = serviceClient();
  tokenEncryptionSecret();
  const mailboxEmail = (profile.mail || profile.userPrincipalName || "").trim().toLowerCase();
  const nowIso = new Date().toISOString();
  const accessTokenExpiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID")?.trim() || "";
  const authorityHost = Deno.env.get("MICROSOFT_AUTHORITY_HOST")?.trim() || DEFAULT_AUTHORITY_HOST;

  const { data: activeConnection, error: activeError } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id, mailbox_email, microsoft_user_id, status")
    .in("status", ["connected", "error", "reconnect_required"])
    .maybeSingle();

  if (activeError) {
    throw new CallbackError("connection_upsert_failed", "Could not check existing Microsoft mailbox connection", {
      phase: "connection_lookup",
    });
  }

  if (
    activeConnection &&
    activeConnection.microsoft_user_id !== profile.id &&
    String(activeConnection.mailbox_email || "").toLowerCase() !== mailboxEmail
  ) {
    throw new CallbackError(
      "different_mailbox_already_connected",
      "A different Microsoft mailbox is already connected",
      { phase: "connection_lookup" },
    );
  }

  const metadata = {
    graph_profile_captured_at: nowIso,
    graph_profile_fields: ["id", "mail", "userPrincipalName", "displayName"],
    proof_cookie_still_enabled: true,
  };

  const { data: connection, error: upsertError } = await supabase
    .from("microsoft_mailbox_connections")
    .upsert({
      microsoft_user_id: profile.id,
      mailbox_email: mailboxEmail,
      display_name: profile.displayName || null,
      connected_by: userId,
      connected_at: nowIso,
      updated_at: nowIso,
      status: "connected",
      scopes: scopesFromToken(token.scope),
      tenant_id_or_authority: `${authorityHost.replace(/\/+$/, "")}/${tenantId}`,
      access_token_expires_at: accessTokenExpiresAt,
      last_error_code: null,
      last_error_at: null,
      metadata,
    }, { onConflict: "microsoft_user_id" })
    .select("id")
    .single();

  if (upsertError || !connection?.id) {
    throw new CallbackError("connection_upsert_failed", "Could not persist Microsoft mailbox connection", {
      phase: "connection_upsert",
    });
  }

  console.log("[microsoft-auth-callback] metadata persisted", {
    phase: "connection_upsert",
    metadataUpsertSucceeded: true,
    connectionId: connection.id,
  });

  const encryptedRefreshToken = await encryptRefreshToken(token.refreshToken);
  const { error: secretError } = await supabase
    .from("microsoft_mailbox_connection_secrets")
    .upsert({
      connection_id: connection.id,
      refresh_token_ciphertext: encryptedRefreshToken.ciphertext,
      refresh_token_iv: encryptedRefreshToken.iv,
      refresh_token_key_version: encryptedRefreshToken.keyVersion,
      refresh_token_last_rotated_at: nowIso,
      refresh_token_expires_at: isoAfterSeconds(token.refreshTokenExpiresIn),
      updated_at: nowIso,
    }, { onConflict: "connection_id" });

  if (secretError) {
    throw new CallbackError("secret_upsert_failed", "Could not persist encrypted Microsoft refresh token", {
      phase: "secret_upsert",
    });
  }

  console.log("[microsoft-auth-callback] secret persisted", {
    phase: "secret_upsert",
    secretUpsertSucceeded: true,
    connectionId: connection.id,
  });

  return connection.id as string;
}

async function fetchLatestMessages(accessToken: string) {
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
    throw new CallbackError("graph_messages_failed", "Microsoft Graph latest messages request failed", {
      phase: "graph_messages",
      status: response.status,
      microsoftError: typeof payload?.error?.code === "string" ? payload.error.code : undefined,
    });
  }
  return Array.isArray(payload?.value) ? payload.value.map(sanitizeMessage) : [];
}

function redirect(location: string, headers: HeadersInit = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function withQuery(location: string, params: Record<string, string>) {
  const url = new URL(location);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function safeReason(error: unknown) {
  if (error instanceof CallbackError) return error.reason;
  if (error instanceof Error && error.message.startsWith("microsoft_oauth_error:")) return "microsoft_oauth_error";
  return "unexpected_callback_error";
}

function safeErrorLog(error: unknown) {
  if (error instanceof CallbackError) {
    return {
      reason: error.reason,
      phase: error.phase,
      status: error.status,
      microsoftError: error.microsoftError,
      microsoftErrorCodes: error.microsoftErrorCodes,
    };
  }

  if (error instanceof Error) {
    return {
      reason: safeReason(error),
      phase: "callback",
      message: error.message.slice(0, 160),
    };
  }

  return {
    reason: "unexpected_callback_error",
    phase: "callback",
  };
}

function getFrontendReturnUrl(stateReturnTo?: string) {
  const configured = Deno.env.get("EMAIL_TRIAGE_APP_URL")?.trim();
  const candidate = configured || stateReturnTo || DEFAULT_LOCAL_APP_URL;

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid_protocol");
    return url.toString();
  } catch {
    return DEFAULT_LOCAL_APP_URL;
  }
}

serve(async (req) => {
  const url = new URL(req.url);

  try {
    const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const oauthError = url.searchParams.get("error") || "";
    if (oauthError) {
      throw new CallbackError("microsoft_oauth_error", "Microsoft returned an OAuth error", {
        phase: "microsoft_authorize",
        microsoftError: oauthError,
      });
    }
    if (!code) {
      throw new CallbackError("missing_code", "Callback is missing code", {
        phase: "microsoft_authorize",
      });
    }
    if (!state) {
      throw new CallbackError("invalid_state", "Callback is missing state", {
        phase: "microsoft_authorize",
      });
    }

    const statePayload = await verifyState(state, clientSecret);
    await verifyAdminUser(statePayload.sub);
    const token = await exchangeCodeForToken(code);
    const profile = await fetchGraphProfile(token.accessToken);
    console.log("[microsoft-auth-callback] graph profile loaded", {
      phase: "graph_me",
      graphMeSucceeded: true,
    });
    const connectionId = await persistConnection(statePayload.sub, token, profile);
    const messages = await fetchLatestMessages(token.accessToken);
    const cookieMaxAge = Math.max(60, Math.min(token.expiresIn - 60, 50 * 60));
    const encryptedToken = await encryptPayload({
      accessToken: token.accessToken,
      sub: statePayload.sub,
      scope: token.scope,
      expiresAt: Date.now() + cookieMaxAge * 1000,
    }, clientSecret);

    console.log("[microsoft-auth-callback] auth success", {
      phase: "callback_complete",
      userId: statePayload.sub,
      connectionId,
      messageCount: messages.length,
    });

    const returnTo = getFrontendReturnUrl(statePayload.returnTo);
    return redirect(withQuery(returnTo, { outlook: "connected", count: String(messages.length) }), {
      "Set-Cookie": `${COOKIE_NAME}=${encryptedToken}; ${cookieAttributes(req, cookieMaxAge)}`,
    });
  } catch (error) {
    const errorLog = safeErrorLog(error);
    console.error("[microsoft-auth-callback] failed", errorLog);
    return redirect(withQuery(getFrontendReturnUrl(), {
      outlook: "error",
      reason: safeReason(error),
    }));
  }
});
