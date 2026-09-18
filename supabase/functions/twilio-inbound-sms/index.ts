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
const CHANGE_USERNAME_KEYWORDS = new Set(["change", "update", "edit"]);
const EBAY_USERNAME_PATTERN = /^[A-Za-z0-9._-]{2,64}$/;

type SubscriberRecord = {
  id: string;
  status: string | null;
  sms_consent: boolean | null;
  ebay_username: string | null;
  metadata: Record<string, unknown> | null;
};

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

function withOptOut(message: string) {
  if (/\breply\s+stop\b|\bstop\s+to\s+unsubscribe\b/i.test(message)) return message;
  return `${message.replace(/\s+$/, "")} Reply STOP to unsubscribe.`;
}

function sms(message: string, status = 200) {
  return xml(withOptOut(message), status);
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
    eventType: "help" | "unknown" | "ebay_username_rejected";
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

function subscriberMetadata(subscriber: SubscriberRecord | null): Record<string, unknown> {
  if (!subscriber?.metadata || typeof subscriber.metadata !== "object" || Array.isArray(subscriber.metadata)) {
    return {};
  }
  return subscriber.metadata;
}

function isSubscribed(subscriber: SubscriberRecord | null) {
  return subscriber?.status === "subscribed" && subscriber.sms_consent === true;
}

function isUsernameChangePending(subscriber: SubscriberRecord | null) {
  return subscriberMetadata(subscriber).ebay_username_change_pending === true;
}

function normalizeEbayUsername(value: unknown) {
  return text(value).replace(/^@+/, "");
}

function validateEbayUsername(username: string) {
  return EBAY_USERNAME_PATTERN.test(username);
}

async function getSmsSubscriber(supabase: any, phone: string): Promise<SubscriberRecord | null> {
  const { data, error } = await supabase
    .from("customer_sms_subscribers")
    .select("id,status,sms_consent,ebay_username,metadata")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function requestUsernameChange(
  supabase: any,
  subscriber: SubscriberRecord,
  input: {
    phone: string;
    toPhone: string;
    body: string;
    rawPayload: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const metadata = {
    ...subscriberMetadata(subscriber),
    ebay_username_change_pending: true,
    ebay_username_change_requested_at: now,
  };

  const { error: updateError } = await supabase
    .from("customer_sms_subscribers")
    .update({
      metadata,
      last_inbound_body: input.body || null,
      last_inbound_at: now,
    })
    .eq("id", subscriber.id);
  if (updateError) throw updateError;

  const { error: eventError } = await supabase.from("customer_sms_events").insert({
    subscriber_id: subscriber.id,
    phone_e164: input.phone,
    from_phone: input.phone,
    to_phone: input.toPhone || null,
    direction: "inbound",
    event_type: "ebay_username_change_requested",
    body: input.body || null,
    raw_payload: input.rawPayload,
  });
  if (eventError) throw eventError;
}

async function saveEbayUsername(
  supabase: any,
  subscriber: SubscriberRecord,
  input: {
    phone: string;
    toPhone: string;
    body: string;
    username: string;
    rawPayload: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const metadata = {
    ...subscriberMetadata(subscriber),
    ebay_username_change_pending: false,
    ebay_username_updated_at: now,
  };

  const { error: updateError } = await supabase
    .from("customer_sms_subscribers")
    .update({
      ebay_username: input.username,
      ebay_username_collected_at: now,
      ebay_username_source: "inbound_sms",
      metadata,
      last_inbound_body: input.body || null,
      last_inbound_at: now,
    })
    .eq("id", subscriber.id);
  if (updateError) throw updateError;

  const { error: eventError } = await supabase.from("customer_sms_events").insert({
    subscriber_id: subscriber.id,
    phone_e164: input.phone,
    from_phone: input.phone,
    to_phone: input.toPhone || null,
    direction: "inbound",
    event_type: "ebay_username_saved",
    body: input.body || null,
    raw_payload: {
      ...input.rawPayload,
      ebay_username: input.username,
    },
  });
  if (eventError) throw eventError;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return sms("OG Jewelers: Text OG to subscribe.", 405);

  let params: URLSearchParams;
  try {
    params = await parseParams(req);
  } catch (error) {
    console.error("[twilio-inbound-sms] parse failed", error);
    return sms("OG Jewelers: We could not read that message. Please try again.");
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
    return sms("OG Jewelers: We could not read your phone number. Please try again.");
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
        _metadata: {
          ...metadata,
          ebay_username_change_pending: false,
        },
      });
      if (error) throw error;

      if (optOutType === "STOP") return xml(null);
      return xml("OG Jewelers: You are unsubscribed and will no longer receive OG Jewelers texts. Reply START to resubscribe.");
    }

    if (matchedSubscribe) {
      const { error } = await supabase.rpc("customer_sms_record_opt_in", {
        _phone_e164: fromPhone,
        _consent_source: optOutType === "START" ? "twilio_opt_in" : "inbound_sms",
        _consent_text: `Customer texted ${body || "START"} to opt in to OG Jewelers SMS updates.`,
        _name: null,
        _email: null,
        _source: "inbound_sms",
        _campaign: null,
        _inbound_body: body || null,
        _metadata: metadata,
      });
      if (error) throw error;

      if (optOutType === "START") return xml(null);
      return sms("OG Jewelers: You are subscribed to OG live show texts. If you want to participate in more promotions, send your eBay username as publicly displayed. Just the public username, nothing more.");
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
      return sms("OG Jewelers alerts: text OG or SUBSCRIBE to join live show updates. Reply CHANGE to update your public eBay username.");
    }

    const subscriber = await getSmsSubscriber(supabase, fromPhone);
    if (!isSubscribed(subscriber)) {
      await insertInboundEvent(supabase, {
        phone: fromPhone,
        toPhone,
        body,
        eventType: "unknown",
        rawPayload: metadata,
      });
      return sms("OG Jewelers: text OG or SUBSCRIBE to get live show alerts.");
    }

    if (CHANGE_USERNAME_KEYWORDS.has(fullCommand) || CHANGE_USERNAME_KEYWORDS.has(headCommand)) {
      await requestUsernameChange(supabase, subscriber as SubscriberRecord, {
        phone: fromPhone,
        toPhone,
        body,
        rawPayload: metadata,
      });
      return sms("OG Jewelers: Send the new eBay username as publicly displayed. Just the public username, nothing more.");
    }

    if (isUsernameChangePending(subscriber) || !subscriber?.ebay_username) {
      const username = normalizeEbayUsername(body);
      if (!validateEbayUsername(username)) {
        await insertInboundEvent(supabase, {
          phone: fromPhone,
          toPhone,
          body,
          eventType: "ebay_username_rejected",
          rawPayload: {
            ...metadata,
            rejection_reason: "invalid_ebay_username",
          },
        });
        return sms("OG Jewelers: Please send only your public eBay username using letters, numbers, dots, dashes, or underscores.");
      }

      await saveEbayUsername(supabase, subscriber as SubscriberRecord, {
        phone: fromPhone,
        toPhone,
        body,
        username,
        rawPayload: metadata,
      });
      return sms(`OG Jewelers: Your eBay username on file is ${username}. To change it, reply CHANGE.`);
    }

    await insertInboundEvent(supabase, {
      phone: fromPhone,
      toPhone,
      body,
      eventType: "unknown",
      rawPayload: metadata,
    });
    return sms(`OG Jewelers: Your eBay username on file is ${subscriber.ebay_username}. To change it, reply CHANGE.`);
  } catch (error) {
    console.error("[twilio-inbound-sms] update failed", error);
    return sms("OG Jewelers: We could not update your SMS status right now. Please try again.");
  }
});
