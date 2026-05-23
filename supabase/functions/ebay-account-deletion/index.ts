import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VERIFICATION_TOKEN = Deno.env.get("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN") ?? "";
const ENDPOINT_URL = Deno.env.get("EBAY_ACCOUNT_DELETION_ENDPOINT_URL") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function findValue(payload: any, keys: string[]): string | null {
  if (!payload || typeof payload !== "object") return null;

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const value of Object.values(payload)) {
    if (value && typeof value === "object") {
      const found = findValue(value, keys);
      if (found) return found;
    }
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const challengeCode = url.searchParams.get("challenge_code") || "";

    if (!challengeCode) return json(400, { error: "missing_challenge_code" });
    if (!VERIFICATION_TOKEN || !ENDPOINT_URL) {
      return json(500, { error: "missing_endpoint_verification_config" });
    }

    const challengeResponse = await sha256Hex(`${challengeCode}${VERIFICATION_TOKEN}${ENDPOINT_URL}`);
    return json(200, { challengeResponse });
  }

  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("ebay_account_deletion_notifications").insert({
      notification_id: findValue(payload, ["notificationId", "notification_id", "eventId", "event_id"]),
      username: findValue(payload, ["username", "userName", "user_name"]),
      eias_token: findValue(payload, ["eiasToken", "eias_token", "EIASToken"]),
      raw_payload: payload,
    });
  }

  return new Response(null, { status: 204, headers: corsHeaders });
});
