import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUBSCRIBE_KEYWORDS = new Set([
  "og",
  "subscribe",
  "susbcribe",
  "subscribed",
  "join",
  "signup",
  "live",
  "start",
  "unstop",
  "yes",
]);

const UNSUBSCRIBE_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "unsubscribed",
  "cancel",
  "end",
  "quit",
  "revoke",
  "optout",
]);

const HELP_KEYWORDS = new Set(["help", "info"]);

function xml(message: string | null, status = 200) {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function cleanCommand(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstCommand(value: unknown) {
  return cleanCommand(text(value).split(/\s+/)[0] || "");
}

function normalizePhone(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const candidate = raw.startsWith("+")
    ? `+${raw.slice(1).replace(/\D/g, "")}`
    : `+${raw.replace(/\D/g, "")}`;
  return /^\+\d{7,15}$/.test(candidate) ? candidate : "";
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function paramsToObject(params: URLSearchParams) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const current = out[key];
      out[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function hmacSha1Base64(secret: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function validateTwilioSignature(req: Request, params: URLSearchParams) {
  const allowInsecure = optionalEnv("ALLOW_INSECURE_TWILIO_WEBHOOK").toLowerCase() === "true";
  const authToken = optionalEnv("TWILIO_AUTH_TOKEN");
  const signature = req.headers.get("x-twilio-signature") || "";

  if (!authToken) return allowInsecure;
  if (!signature) return false;

  const configuredUrl = optionalEnv("TWILIO_INBOUND_WEBHOOK_URL", "TWILIO_WEBHOOK_URL") || req.url;
  const sorted = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const base = sorted.reduce((acc, [key, value]) => `${acc}${key}${value}`, configuredUrl);
  const expected = await hmacSha1Base64(authToken, base);
  return safeEqual(signature, expected);
}

async function parseParams(req: Request) {
  const rawBody = await req.text();
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(rawBody || "{}") as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) params.set(key, text(value));
    return params;
  }
  return new URLSearchParams(rawBody);
}

async function insertInboundEvent(
  supabase: any,
  input: {
    phone: string;
    toPhone: string;
    body: string;
    eventType: "help" | "unknown";
    rawPayload: Record<string, unknown>;
  },
) {
  const { data: subscriber } = await supabase
    .from("customer_sms_subscribers")
    .select("id")
    .eq("phone_e164", input.phone)
    .maybeSingle();

  await supabase.from("customer_sms_events").insert({
    subscriber_id: subscriber?.id || null,
    phone_e164: input.phone,
    from_phone: input.phone,
    to_phone: input.toPhone || null,
    direction: "inbound",
    event_type: input.eventType,
    body: input.body || null,
    raw_payload: input.rawPayload,
  });

  if (subscriber?.id) {
    await supabase
      .from("customer_sms_subscribers")
      .update({
        last_inbound_body: input.body || null,
        last_inbound_at: new Date().toISOString(),
      })
      .eq("id", subscriber.id);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return xml("OG Jewelry: Text OG to subscribe. Reply STOP to unsubscribe.", 405);

  let params: URLSearchParams;
  try {
    params = await parseParams(req);
  } catch (error) {
    console.error("[twilio-inbound-sms] parse failed", error);
    return xml("OG Jewelry: We could not read that message. Please try again.");
  }

  const signatureOk = await validateTwilioSignature(req, params);
  if (!signatureOk) return xml(null, 403);

  const rawPayload = paramsToObject(params);
  const fromPhone = normalizePhone(params.get("From"));
  const toPhone = normalizePhone(params.get("To"));
  const body = text(params.get("Body"));
  const optOutType = text(params.get("OptOutType")).toUpperCase();
  const fullCommand = cleanCommand(body);
  const headCommand = firstCommand(body);

  if (!fromPhone) {
    console.error("[twilio-inbound-sms] missing sender", rawPayload);
    return xml("OG Jewelry: We could not read your phone number. Please try again.");
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const metadata = {
    ...rawPayload,
    to_phone: toPhone || params.get("To") || "",
    message_sid: params.get("MessageSid") || params.get("SmsSid") || params.get("SmsMessageSid") || "",
    received_at: new Date().toISOString(),
  };

  const matchedSubscribe =
    optOutType === "START" ||
    SUBSCRIBE_KEYWORDS.has(fullCommand) ||
    SUBSCRIBE_KEYWORDS.has(headCommand);
  const matchedUnsubscribe =
    optOutType === "STOP" ||
    UNSUBSCRIBE_KEYWORDS.has(fullCommand) ||
    UNSUBSCRIBE_KEYWORDS.has(headCommand);
  const matchedHelp =
    optOutType === "HELP" ||
    HELP_KEYWORDS.has(fullCommand) ||
    HELP_KEYWORDS.has(headCommand);

  try {
    if (matchedUnsubscribe) {
      const { error } = await supabase.rpc("customer_sms_record_opt_out", {
        _phone_e164: fromPhone,
        _opt_out_source: optOutType === "STOP" ? "twilio_opt_out" : "inbound_sms",
        _inbound_body: body || null,
        _metadata: metadata,
      });
      if (error) throw error;

      if (optOutType === "STOP") return xml(null);
      return xml("OG Jewelry: You are unsubscribed and will no longer receive OG Jewelry texts. Reply START to resubscribe.");
    }

    if (matchedSubscribe) {
      const { error } = await supabase.rpc("customer_sms_record_opt_in", {
        _phone_e164: fromPhone,
        _consent_source: optOutType === "START" ? "twilio_opt_in" : "inbound_sms",
        _consent_text: `Customer texted ${body || "START"} to opt in to OG Jewelry SMS updates.`,
        _name: null,
        _email: null,
        _source: "inbound_sms",
        _campaign: null,
        _inbound_body: body || null,
        _metadata: metadata,
      });
      if (error) throw error;

      if (optOutType === "START") return xml(null);
      return xml("OG Jewelry: You are subscribed to OG live show texts. Reply STOP to unsubscribe.");
    }

    if (matchedHelp) {
      await insertInboundEvent(supabase, {
        phone: fromPhone,
        toPhone,
        body,
        eventType: "help",
        rawPayload: metadata,
      });
      if (optOutType === "HELP") return xml(null);
      return xml("OG Jewelry alerts: text OG or SUBSCRIBE to join live show updates. Reply STOP to unsubscribe.");
    }

    await insertInboundEvent(supabase, {
      phone: fromPhone,
      toPhone,
      body,
      eventType: "unknown",
      rawPayload: metadata,
    });
    return xml("OG Jewelry: text OG or SUBSCRIBE to get live show alerts. Reply STOP to unsubscribe.");
  } catch (error) {
    console.error("[twilio-inbound-sms] update failed", error);
    return xml("OG Jewelry: We could not update your SMS status right now. Please try again.");
  }
});
