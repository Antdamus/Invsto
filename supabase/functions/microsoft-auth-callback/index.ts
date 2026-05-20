import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const COOKIE_NAME = "og_ms_graph_poc";

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
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
  if (!payload || !signature) throw new Error("invalid_state");
  const expected = await hmacSha256(secret, payload);
  if (expected !== signature) throw new Error("invalid_state_signature");

  const decoded = decodeJson<{ sub?: string; exp?: number; returnTo?: string }>(payload);
  const now = Math.floor(Date.now() / 1000);
  if (!decoded.sub || !decoded.exp || decoded.exp < now) throw new Error("expired_state");
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

  if (error) throw new Error("employee_lookup_failed");
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new Error("admin_required");
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
    throw new Error(`token_exchange_failed:${response.status}`);
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
  if (!response.ok) throw new Error(`graph_messages_failed:${response.status}`);
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

serve(async (req) => {
  const url = new URL(req.url);

  try {
    const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const oauthError = url.searchParams.get("error") || "";
    if (oauthError) throw new Error(`microsoft_oauth_error:${oauthError}`);
    if (!code || !state) throw new Error("missing_code_or_state");

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

    const returnTo = statePayload.returnTo || "/email-triage.html";
    return redirect(withQuery(returnTo, { outlook: "connected", count: String(messages.length) }), {
      "Set-Cookie": `${COOKIE_NAME}=${encryptedToken}; ${cookieAttributes(req, cookieMaxAge)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[microsoft-auth-callback] failed", { error: message });
    const fallback = url.searchParams.get("state") ? "email-triage.html" : "/";
    return redirect(withQuery(new URL(fallback, req.url).toString(), { outlook: "error" }));
  }
});
