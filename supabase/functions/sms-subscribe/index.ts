import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_CONSENT_TEXT =
  "I agree to receive recurring automated SMS live show alerts from OG Jewelry at the number provided. Reply STOP to unsubscribe. Message and data rates may apply.";

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

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return text(value).toLowerCase();
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getClientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

function normalizePhone(value: unknown) {
  const raw = text(value);
  if (!raw) return "";

  if (raw.startsWith("+")) {
    const candidate = `+${raw.slice(1).replace(/\D/g, "")}`;
    return /^\+\d{7,15}$/.test(candidate) ? candidate : "";
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function isValidEmail(email: string) {
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const payload = objectOrEmpty(await req.json().catch(() => null));
    const phone = normalizePhone(payload.phone || payload.phone_e164 || payload.mobile);
    const smsConsent = payload.smsConsent === true || payload.sms_consent === true;
    const name = text(payload.name).slice(0, 160);
    const email = lower(payload.email).slice(0, 254);
    const source = text(payload.source || payload.src).slice(0, 120);
    const campaign = text(payload.campaign).slice(0, 160);
    const consentText = text(payload.consentText || payload.consent_text || DEFAULT_CONSENT_TEXT).slice(0, 1000);

    if (!phone) return json(400, { ok: false, error: "invalid_phone" });
    if (!smsConsent) return json(400, { ok: false, error: "sms_consent_required" });
    if (!isValidEmail(email)) return json(400, { ok: false, error: "invalid_email" });

    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const metadata = {
      request_ip: getClientIp(req),
      user_agent: req.headers.get("user-agent") || "",
      source_url: text(payload.sourceUrl || payload.source_url).slice(0, 500),
      captured_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.rpc("customer_sms_record_opt_in", {
      _phone_e164: phone,
      _consent_source: "website_registration",
      _consent_text: consentText,
      _name: name || null,
      _email: email || null,
      _source: source || "direct",
      _campaign: campaign || null,
      _inbound_body: null,
      _metadata: metadata,
    });

    if (error) {
      console.error("[sms-subscribe] opt-in failed", error);
      return json(500, { ok: false, error: "subscribe_failed", detail: error.message });
    }

    return json(200, {
      ok: true,
      subscriber: {
        id: data?.id || null,
        phone_e164: data?.phone_e164 || phone,
        status: data?.status || "subscribed",
        opted_in_at: data?.opted_in_at || null,
      },
    });
  } catch (error) {
    console.error("[sms-subscribe] unexpected error", error);
    return json(500, {
      ok: false,
      error: "unexpected_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});
