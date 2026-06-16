import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type ServiceClient = ReturnType<typeof createClient>;
type PublicKeyCacheEntry = { key: CryptoKey | null; spkiBytes: Uint8Array; expiresAt: number };
type P256Point = { x: bigint; y: bigint } | null;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")?.trim() || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
const VERIFICATION_TOKEN = Deno.env.get("EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN")?.trim() || "";
const ENDPOINT_URL = Deno.env.get("EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL")?.trim() || "";
const DEFAULT_NOTIFICATION_SCOPE = "https://api.ebay.com/oauth/api_scope";
const publicKeyCache = new Map<string, PublicKeyCacheEntry>();

const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_A = P256_P - 3n;
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_G: P256Point = {
  x: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  y: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ebay-signature",
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

function supabaseClient(): ServiceClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function challengeEndpointUrl(requestUrl: string) {
  if (ENDPOINT_URL) return ENDPOINT_URL;
  const url = new URL(requestUrl);
  return `${url.origin}${url.pathname}`;
}

function text(value: unknown) {
  return String(value || "").trim();
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function findValue(payload: unknown, keys: string[]): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as JsonRecord;

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = findValue(value, keys);
      if (found) return found;
    }
  }

  return null;
}

function isoOrNull(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function booleanOrNull(value: unknown) {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["true", "1", "read"].includes(normalized)) return true;
  if (["false", "0", "unread"].includes(normalized)) return false;
  return null;
}

function base64Bytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64Text(value: string) {
  return new TextDecoder().decode(base64Bytes(value));
}

function pemToSpkiBytes(pem: string) {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return base64Bytes(body);
}

function derEcdsaToRaw(signature: Uint8Array, size = 32) {
  if (signature[0] !== 0x30) return signature;
  let offset = 2;
  if (signature[1] & 0x80) offset = 2 + (signature[1] & 0x7f);
  if (signature[offset] !== 0x02) return signature;
  const rLength = signature[offset + 1];
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  offset = offset + 2 + rLength;
  if (signature[offset] !== 0x02) return signature;
  const sLength = signature[offset + 1];
  const s = signature.slice(offset + 2, offset + 2 + sLength);

  const out = new Uint8Array(size * 2);
  out.set(r.slice(Math.max(0, r.length - size)), size - Math.min(size, r.length));
  out.set(s.slice(Math.max(0, s.length - size)), size * 2 - Math.min(size, s.length));
  return out;
}

function mod(value: bigint, modulus: bigint) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function modInverse(value: bigint, modulus: bigint) {
  let a = mod(value, modulus);
  let b = modulus;
  let x = 0n;
  let y = 1n;
  let lastX = 1n;
  let lastY = 0n;

  while (b !== 0n) {
    const quotient = a / b;
    [a, b] = [b, a % b];
    [lastX, x] = [x, lastX - quotient * x];
    [lastY, y] = [y, lastY - quotient * y];
  }

  if (a !== 1n) throw new Error("p256_inverse_missing");
  return mod(lastX, modulus);
}

function bytesToBigInt(bytes: Uint8Array) {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) + BigInt(byte);
  return result;
}

function pointFromSpkiBytes(spkiBytes: Uint8Array): P256Point {
  let offset = -1;
  for (let i = 0; i <= spkiBytes.length - 68; i += 1) {
    if (spkiBytes[i] !== 0x03) continue;
    if (spkiBytes[i + 1] === 0x42 && spkiBytes[i + 2] === 0x00 && spkiBytes[i + 3] === 0x04) {
      offset = i + 3;
      break;
    }
    if (
      spkiBytes[i + 1] === 0x81 &&
      spkiBytes[i + 2] === 0x42 &&
      spkiBytes[i + 3] === 0x00 &&
      spkiBytes[i + 4] === 0x04
    ) {
      offset = i + 4;
      break;
    }
  }

  if (offset < 0 || offset + 65 > spkiBytes.length) throw new Error("p256_public_key_point_missing");
  const x = bytesToBigInt(spkiBytes.slice(offset + 1, offset + 33));
  const y = bytesToBigInt(spkiBytes.slice(offset + 33, offset + 65));
  if (mod((y * y) - (x * x * x) - (P256_A * x) - P256_B, P256_P) !== 0n) {
    throw new Error("p256_public_key_point_invalid");
  }
  return { x, y };
}

function pointAdd(left: P256Point, right: P256Point): P256Point {
  if (!left) return right;
  if (!right) return left;

  if (left.x === right.x) {
    if (mod(left.y + right.y, P256_P) === 0n) return null;
    const numerator = mod((3n * left.x * left.x) + P256_A, P256_P);
    const denominator = modInverse(2n * left.y, P256_P);
    const lambda = mod(numerator * denominator, P256_P);
    const x = mod((lambda * lambda) - (2n * left.x), P256_P);
    const y = mod(lambda * (left.x - x) - left.y, P256_P);
    return { x, y };
  }

  const lambda = mod((right.y - left.y) * modInverse(right.x - left.x, P256_P), P256_P);
  const x = mod((lambda * lambda) - left.x - right.x, P256_P);
  const y = mod(lambda * (left.x - x) - left.y, P256_P);
  return { x, y };
}

function scalarMultiply(scalar: bigint, point: P256Point): P256Point {
  let result: P256Point = null;
  let addend = point;
  let value = scalar;

  while (value > 0n) {
    if (value & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    value >>= 1n;
  }

  return result;
}

async function verifyEcdsaSha1P256Fallback(spkiBytes: Uint8Array, signature: Uint8Array, rawBody: string) {
  if (signature.length !== 64) throw new Error("p256_signature_length_invalid");
  const r = bytesToBigInt(signature.slice(0, 32));
  const s = bytesToBigInt(signature.slice(32, 64));
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) return false;

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(rawBody)));
  const z = bytesToBigInt(digest);
  const w = modInverse(s, P256_N);
  const u1 = mod(z * w, P256_N);
  const u2 = mod(r * w, P256_N);
  const point = pointAdd(
    scalarMultiply(u1, P256_G),
    scalarMultiply(u2, pointFromSpkiBytes(spkiBytes)),
  );

  return Boolean(point && mod(point.x, P256_N) === r);
}

async function parseResponse(res: Response) {
  const bodyText = await res.text();
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    return { raw: bodyText.slice(0, 500) };
  }
}

function ebayEnvironment() {
  const value = (Deno.env.get("EBAY_ENV") || "production").trim().toLowerCase();
  return value === "sandbox" ? "sandbox" : "production";
}

function ebayApiBase() {
  return ebayEnvironment() === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

async function refreshClientCredentialsToken() {
  const clientId = optionalEnv("EBAY_CLIENT_ID", "EBAY_APP_ID");
  const clientSecret = optionalEnv("EBAY_CLIENT_SECRET", "EBAY_CERT_ID");
  const scope = (Deno.env.get("EBAY_NOTIFICATION_SCOPE") || DEFAULT_NOTIFICATION_SCOPE).trim() || DEFAULT_NOTIFICATION_SCOPE;
  if (!clientId || !clientSecret) throw new Error("missing_ebay_client_credentials");

  const res = await fetch(`${ebayApiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    }),
  });
  const payload = await parseResponse(res);
  if (!res.ok) throw new Error(`ebay_notification_oauth_failed:${res.status}:${text((payload as JsonRecord).message)}`);
  const token = text((payload as JsonRecord).access_token);
  if (!token) throw new Error("ebay_notification_oauth_missing_access_token");
  return token;
}

async function publicKeyForKid(kid: string) {
  const cached = publicKeyCache.get(kid);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const token = await refreshClientCredentialsToken();
  const res = await fetch(`${ebayApiBase()}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });
  const payload = await parseResponse(res);
  if (!res.ok) throw new Error(`ebay_public_key_fetch_failed:${res.status}`);
  const pem = text((payload as JsonRecord).key);
  if (!pem) throw new Error("ebay_public_key_missing_key");
  const spkiBytes = pemToSpkiBytes(pem);

  let key: CryptoKey | null = null;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      spkiBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    console.warn("[ebay-message-notification] public key import fallback will be used", error instanceof Error ? error.message : error);
  }

  const entry = { key, spkiBytes, expiresAt: Date.now() + 60 * 60 * 1000 };
  publicKeyCache.set(kid, entry);
  return entry;
}

async function verifyEbaySignature(signatureHeader: string | null, rawBody: string) {
  if (!signatureHeader) return { verified: false, error: "missing_x_ebay_signature", kid: null };
  try {
    const decoded = JSON.parse(base64Text(signatureHeader)) as JsonRecord;
    const kid = text(decoded.kid);
    const signatureValue = text(decoded.signature);
    if (!kid || !signatureValue) return { verified: false, error: "signature_header_missing_kid_or_signature", kid: kid || null };

    const publicKey = await publicKeyForKid(kid);
    const signature = derEcdsaToRaw(base64Bytes(signatureValue));
    let verified = false;
    if (publicKey.key) {
      try {
        verified = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-1" },
          publicKey.key,
          signature,
          new TextEncoder().encode(rawBody),
        );
      } catch (error) {
        console.warn("[ebay-message-notification] native ECDSA SHA1 verify fallback will be used", error instanceof Error ? error.message : error);
      }
    }
    if (!verified) {
      verified = await verifyEcdsaSha1P256Fallback(publicKey.spkiBytes, signature, rawBody);
    }
    return { verified, error: verified ? null : "signature_verification_failed", kid };
  } catch (error) {
    return {
      verified: false,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error || "signature_verification_error").slice(0, 500),
      kid: null,
    };
  }
}

function payloadFields(payload: JsonRecord) {
  const metadata = recordOrEmpty(payload.metadata);
  const notification = recordOrEmpty(payload.notification);
  const data = recordOrEmpty(notification.data);
  return {
    notificationId: text(notification.notificationId) || findValue(payload, ["notificationId", "notification_id", "eventId", "event_id"]),
    topic: text(metadata.topic) || findValue(payload, ["topic"]),
    eventDate: isoOrNull(notification.eventDate),
    publishDate: isoOrNull(notification.publishDate),
    publishAttemptCount: Number(notification.publishAttemptCount || 0) || null,
    ebayConversationId: text(data.conversationId) || findValue(payload, ["conversationId", "conversation_id"]),
    conversationType: text(data.conversationType) || findValue(payload, ["conversationType", "conversation_type"]),
    ebayMessageId: text(data.messageId) || findValue(payload, ["messageId", "message_id"]),
    readStatus: booleanOrNull(data.readStatus ?? findValue(payload, ["readStatus", "read_status"])),
  };
}

function requestHeadersForLog(req: Request) {
  return {
    "x-ebay-signature": req.headers.get("X-EBAY-SIGNATURE") ? "[present]" : null,
    "content-type": req.headers.get("Content-Type"),
    "user-agent": req.headers.get("User-Agent"),
  };
}

async function insertNotification(options: {
  supabase: ServiceClient | null;
  fields: ReturnType<typeof payloadFields>;
  rawPayload: JsonRecord;
  rawHeaders: JsonRecord;
  signatureVerified: boolean;
  signatureError: string | null;
  processingStatus: string;
}) {
  if (!options.supabase) return null;
  const row = {
    notification_id: options.fields.notificationId,
    topic: options.fields.topic,
    event_date: options.fields.eventDate,
    publish_date: options.fields.publishDate,
    publish_attempt_count: options.fields.publishAttemptCount,
    ebay_conversation_id: options.fields.ebayConversationId,
    conversation_type: ["FROM_MEMBERS", "FROM_EBAY"].includes(String(options.fields.conversationType || "").toUpperCase())
      ? String(options.fields.conversationType || "").toUpperCase()
      : null,
    ebay_message_id: options.fields.ebayMessageId,
    read_status: options.fields.readStatus,
    signature_verified: options.signatureVerified,
    signature_verification_error: options.signatureError,
    processing_status: options.processingStatus,
    raw_headers: options.rawHeaders,
    raw_payload: options.rawPayload,
  };

  const { data, error } = await options.supabase
    .from("ebay_message_notifications")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (!error) return data?.id || null;

  if (error.code === "23505" && options.fields.notificationId) {
    const { data: updated, error: updateError } = await options.supabase
      .from("ebay_message_notifications")
      .update(row)
      .eq("notification_id", options.fields.notificationId)
      .select("id")
      .maybeSingle();
    if (updateError) console.warn("[ebay-message-notification] notification retry update failed", updateError.message);
    return updated?.id || null;
  }

  console.warn("[ebay-message-notification] notification insert failed", error.message);
  return data?.id || null;
}

async function updateNotification(options: {
  supabase: ServiceClient | null;
  id: string | null;
  status: string;
  syncRunId?: string | null;
  syncResponse?: JsonRecord;
}) {
  if (!options.supabase || !options.id) return;
  const { error } = await options.supabase
    .from("ebay_message_notifications")
    .update({
      processing_status: options.status,
      sync_run_id: options.syncRunId || null,
      sync_response: options.syncResponse || {},
      processed_at: new Date().toISOString(),
    })
    .eq("id", options.id);
  if (error) console.warn("[ebay-message-notification] notification update failed", error.message);
}

async function recordActivity(options: {
  supabase: ServiceClient | null;
  fields: ReturnType<typeof payloadFields>;
  status: string;
  metadata: JsonRecord;
}) {
  if (!options.supabase) return;
  const { data: conversation } = options.fields.ebayConversationId
    ? await options.supabase
      .from("ebay_conversations")
      .select("id")
      .eq("ebay_conversation_id", options.fields.ebayConversationId)
      .maybeSingle()
    : { data: null };

  const { error } = await options.supabase.rpc("record_ebay_message_activity_event", {
    _event_type: "provider_notification_received",
    _status: options.status,
    _actor_user_id: null,
    _actor_email: null,
    _conversation_id: conversation?.id || null,
    _target_message_id: null,
    _draft_id: null,
    _approval_id: null,
    _send_attempt_id: null,
    _classification_id: null,
    _saved_view_id: null,
    _sync_run_id: options.metadata.sync_run_id || null,
    _idempotency_key: `provider_notification_received:${options.fields.notificationId || crypto.randomUUID()}`,
    _title: "eBay notification received",
    _detail: options.fields.ebayConversationId || options.fields.ebayMessageId || options.fields.topic,
    _metadata: options.metadata,
  });
  if (error) console.warn("[ebay-message-notification] activity event failed", error.message);
}

async function requestTargetedSync(fields: ReturnType<typeof payloadFields>) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !fields.ebayConversationId) return null;
  const conversationType = String(fields.conversationType || "").toUpperCase();
  const conversationTypes = ["FROM_MEMBERS", "FROM_EBAY"].includes(conversationType)
    ? [conversationType]
    : ["FROM_MEMBERS", "FROM_EBAY"];

  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/ebay-message-sync`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "sync",
      runType: "manual",
      conversationId: fields.ebayConversationId,
      conversationTypes,
      conversationPageLimit: 1,
      messagePageLimit: 50,
      maxConversationPages: 1,
      maxDetailPagesPerConversation: 20,
      classificationMode: "none",
      suppressConversationActivityEvents: false,
    }),
  });
  const payload = await parseResponse(res);
  if (!res.ok || (payload as JsonRecord).ok === false) {
    throw new Error(`targeted_sync_failed:${res.status}:${text((payload as JsonRecord).error || (payload as JsonRecord).message)}`);
  }
  return payload as JsonRecord;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const challengeCode = url.searchParams.get("challenge_code") || "";
    if (!challengeCode) return json(400, { error: "missing_challenge_code" });
    if (!VERIFICATION_TOKEN) return json(500, { error: "missing_endpoint_verification_token" });
    return json(200, { challengeResponse: await sha256Hex(`${challengeCode}${VERIFICATION_TOKEN}${challengeEndpointUrl(req.url)}`) });
  }

  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const supabase = supabaseClient();
  const rawBody = await req.text();
  let payload: JsonRecord = {};
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    payload = {};
  }

  const fields = payloadFields(payload);
  const requireSignature = String(Deno.env.get("EBAY_MESSAGE_NOTIFICATION_REQUIRE_SIGNATURE") || "true").toLowerCase() !== "false";
  const signature = await verifyEbaySignature(req.headers.get("X-EBAY-SIGNATURE"), rawBody);
  const headers = requestHeadersForLog(req);
  const notificationId = await insertNotification({
    supabase,
    fields,
    rawPayload: payload,
    rawHeaders: headers,
    signatureVerified: signature.verified,
    signatureError: signature.error,
    processingStatus: requireSignature && !signature.verified ? "signature_failed" : "received",
  });

  if (requireSignature && !signature.verified) {
    await recordActivity({
      supabase,
      fields,
      status: "failed",
      metadata: {
        notification_id: notificationId,
        topic: fields.topic,
        signature_verified: false,
        signature_error: signature.error,
        safety: {
          ebay_mutation_performed: false,
          automatic_responses_sent: 0,
          sends_enabled: false,
          messages_sent: 0,
        },
      },
    });
    return json(412, { ok: false, error: "signature_verification_failed", detail: signature.error });
  }

  if (String(fields.topic || "").toUpperCase() !== "NEW_MESSAGE" || !fields.ebayConversationId) {
    await updateNotification({ supabase, id: notificationId, status: "ignored" });
    return json(200, { ok: true, status: "ignored", topic: fields.topic || null });
  }

  try {
    await updateNotification({ supabase, id: notificationId, status: "sync_requested" });
    const syncResponse = await requestTargetedSync(fields);
    await updateNotification({
      supabase,
      id: notificationId,
      status: "sync_succeeded",
      syncRunId: text(syncResponse?.runId) || null,
      syncResponse: syncResponse || {},
    });
    await recordActivity({
      supabase,
      fields,
      status: "succeeded",
      metadata: {
        notification_id: notificationId,
        topic: fields.topic,
        ebay_conversation_id: fields.ebayConversationId,
        ebay_message_id: fields.ebayMessageId,
        conversation_type: fields.conversationType,
        signature_verified: signature.verified,
        sync_run_id: text(syncResponse?.runId) || null,
        sync_response: syncResponse || {},
        safety: {
          ebay_mutation_performed: false,
          automatic_responses_sent: 0,
          sends_enabled: false,
          messages_sent: 0,
        },
      },
    });
    return json(200, { ok: true, status: "sync_succeeded", runId: text(syncResponse?.runId) || null });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error || "targeted sync failed").slice(0, 1000);
    await updateNotification({
      supabase,
      id: notificationId,
      status: "sync_failed",
      syncResponse: { error: message },
    });
    await recordActivity({
      supabase,
      fields,
      status: "failed",
      metadata: {
        notification_id: notificationId,
        topic: fields.topic,
        ebay_conversation_id: fields.ebayConversationId,
        ebay_message_id: fields.ebayMessageId,
        conversation_type: fields.conversationType,
        signature_verified: signature.verified,
        error: message,
        safety: {
          ebay_mutation_performed: false,
          automatic_responses_sent: 0,
          sends_enabled: false,
          messages_sent: 0,
        },
      },
    });
    return json(502, { ok: false, error: "targeted_sync_failed", message });
  }
});
