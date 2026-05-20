import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_SCOPES = "offline_access Mail.Read User.Read";
const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";

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
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeBase64Url(value: string) {
  return base64Url(new TextEncoder().encode(value));
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

async function signState(payload: Record<string, unknown>, secret: string) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request) {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const accessToken = getBearerToken(req);
  if (!accessToken) return { ok: false as const, status: 401, error: "missing_authorization" };

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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

function safeReturnTo(value: unknown, fallbackOrigin: string) {
  const fallback = fallbackOrigin ? `${fallbackOrigin}/email-triage.html` : "email-triage.html";
  try {
    const url = new URL(String(value || fallback));
    if (fallbackOrigin && url.origin !== fallbackOrigin) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const clientId = requiredEnv("MICROSOFT_CLIENT_ID");
    const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
    const tenantId = requiredEnv("MICROSOFT_TENANT_ID");
    const redirectUri = requiredEnv("MICROSOFT_REDIRECT_URI");
    const scopes = Deno.env.get("MICROSOFT_GRAPH_SCOPES")?.trim() || DEFAULT_SCOPES;
    const authorityHost = Deno.env.get("MICROSOFT_AUTHORITY_HOST")?.trim() || DEFAULT_AUTHORITY_HOST;
    const body = await req.json().catch(() => ({}));
    const origin = req.headers.get("Origin") || new URL(req.headers.get("Referer") || req.url).origin;

    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const state = await signState({
      sub: admin.userId,
      iat: now,
      exp: now + 10 * 60,
      nonce: base64Url(nonce),
      returnTo: safeReturnTo(body?.returnTo, origin),
    }, clientSecret);

    const authUrl = new URL(`${authorityHost.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);

    console.log("[microsoft-auth-start] authorization URL generated", { userId: admin.userId });
    return json(req, 200, { ok: true, authorizationUrl: authUrl.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[microsoft-auth-start] failed", { error: message });
    return json(req, message.startsWith("missing_env:") ? 500 : 500, { ok: false, error: "auth_start_failed", detail: message });
  }
});
