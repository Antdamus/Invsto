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

async function verifyState(state: string, secret: string): Promise<VerifiedState> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new CallbackError("invalid_state", "OAuth state is malformed", { phase: "state" });
  const expected = await hmacSha256(secret, payload);
  if (expected !== signature) {
    throw new CallbackError("invalid_state_signature", "OAuth state signature did not match", { phase: "state" });
  }

  const decoded = decodeJson<{ sub?: string; exp?: number; returnTo?: string }>(payload);
  const now = Math.floor(Date.now() / 1000);
  if (!decoded.sub || !decoded.exp || decoded.exp < now) {
    throw new CallbackError("expired_state", "OAuth state is missing or expired", { phase: "state" });
  }
  return decoded as VerifiedState;
}

async function verifyAdminUser(userId: string) {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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

async function encryptPayload(payload: Record<string, unknown>, secret: string) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`;
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

async function exchangeCodeForToken(code: string) {
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

  return {
    accessToken: String(payload.access_token),
    expiresIn: Number(payload.expires_in || 3600),
    scope: String(payload.scope || ""),
  };
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
  return "callback_failed";
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
    reason: "callback_failed",
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
    if (!code || !state) {
      throw new CallbackError("missing_code_or_state", "Callback is missing code or state", {
        phase: "microsoft_authorize",
      });
    }

    const statePayload = await verifyState(state, clientSecret);
    await verifyAdminUser(statePayload.sub);
    const token = await exchangeCodeForToken(code);
    const messages = await fetchLatestMessages(token.accessToken);
    const cookieMaxAge = Math.max(60, Math.min(token.expiresIn - 60, 50 * 60));
    const encryptedToken = await encryptPayload({
      accessToken: token.accessToken,
      sub: statePayload.sub,
      scope: token.scope,
      expiresAt: Date.now() + cookieMaxAge * 1000,
    }, clientSecret);

    console.log("[microsoft-auth-callback] auth success", {
      userId: statePayload.sub,
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
