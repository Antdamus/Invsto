import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const COOKIE_NAME = "og_ms_graph_poc";

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
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function decryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptPayload<T>(value: string, secret: string): Promise<T> {
  const [ivText, cipherText] = value.split(".");
  if (!ivText || !cipherText) throw new Error("invalid_mailbox_cookie");
  const key = await decryptionKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(ivText) },
    key,
    decodeBase64Url(cipherText),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
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

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (!["GET", "POST"].includes(req.method)) return json(req, 405, { ok: false, error: "method_not_allowed" });

  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const encryptedToken = parseCookies(req).get(COOKIE_NAME);
    if (!encryptedToken) return json(req, 401, { ok: false, error: "outlook_not_connected" });

    const clientSecret = requiredEnv("MICROSOFT_CLIENT_SECRET");
    const tokenPayload = await decryptPayload<{ accessToken?: string; expiresAt?: number; sub?: string }>(encryptedToken, clientSecret);
    if (!tokenPayload.accessToken || !tokenPayload.expiresAt || tokenPayload.expiresAt < Date.now()) {
      return json(req, 401, { ok: false, error: "outlook_connection_expired" });
    }
    if (tokenPayload.sub && tokenPayload.sub !== admin.userId) {
      return json(req, 403, { ok: false, error: "outlook_connection_user_mismatch" });
    }

    const messages = await fetchLatestMessages(tokenPayload.accessToken);
    console.log("[microsoft-latest-messages] messages loaded", {
      userId: admin.userId,
      messageCount: messages.length,
    });

    return json(req, 200, { ok: true, messages });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[microsoft-latest-messages] failed", { error: message });
    return json(req, 500, { ok: false, error: "latest_messages_failed", detail: message });
  }
});
