import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const receiverPath = path.join(repoRoot, "supabase/functions/ebay-message-notification/index.ts");

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function challengeEndpointUrl(requestUrl, configuredEndpoint = "") {
  if (configuredEndpoint.trim()) return configuredEndpoint.trim();
  const url = new URL(requestUrl);
  return `${url.origin}${url.pathname}`;
}

function base64Bytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function base64Text(value) {
  return Buffer.from(base64Bytes(value)).toString("utf8");
}

function pemToSpkiBytes(pem) {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return base64Bytes(body);
}

function derEcdsaToRaw(signature, size = 32) {
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

async function verifyEbaySignature(signatureHeader, rawBody, publicKeyPemByKid) {
  if (!signatureHeader) return { verified: false, error: "missing_x_ebay_signature", kid: null };
  const decoded = JSON.parse(base64Text(signatureHeader));
  const kid = String(decoded.kid || "").trim();
  const signatureValue = String(decoded.signature || "").trim();
  if (!kid || !signatureValue) return { verified: false, error: "signature_header_missing_kid_or_signature", kid: kid || null };

  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    pemToSpkiBytes(await publicKeyPemByKid(kid)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-1" },
    publicKey,
    derEcdsaToRaw(base64Bytes(signatureValue)),
    new TextEncoder().encode(rawBody),
  );
  return { verified, error: verified ? null : "signature_verification_failed", kid };
}

function toBase64(value) {
  return Buffer.from(value).toString("base64");
}

function pemFromSpki(spki) {
  const body = Buffer.from(spki).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

test("challenge response uses eBay challenge + token + endpoint order", () => {
  const challengeCode = "challenge-123";
  const token = "verification_token_32_chars_minimum";
  const requestUrl = "https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification?challenge_code=challenge-123";
  const endpoint = challengeEndpointUrl(requestUrl);

  assert.equal(endpoint, "https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification");
  assert.equal(
    sha256Hex(`${challengeCode}${token}${endpoint}`),
    "8bd72c20f2d9f1d1b644982c585e43c5a6849c6e9190e87655632269653ba7a2",
  );
});

test("configured endpoint override is preserved exactly for challenge hashing", () => {
  assert.equal(
    challengeEndpointUrl("https://runtime.example/functions/v1/ebay-message-notification?challenge_code=x", "https://public.example/webhook"),
    "https://public.example/webhook",
  );
});

test("valid ECDSA SHA-1 notification signature verifies and tampered payload rejects", async () => {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const rawBody = JSON.stringify({
    metadata: { topic: "NEW_MESSAGE", schemaVersion: "1.0", deprecated: false },
    notification: {
      notificationId: "notification-test-1",
      eventDate: "2026-06-08T00:00:00Z",
      publishDate: "2026-06-08T00:00:01Z",
      publishAttemptCount: 1,
      data: {
        conversationId: "125786456410",
        conversationType: "FROM_MEMBERS",
        messageId: "message-test-1",
        readStatus: false,
      },
    },
  });
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-1" },
    keyPair.privateKey,
    new TextEncoder().encode(rawBody),
  ));
  const publicKeyPem = pemFromSpki(await webcrypto.subtle.exportKey("spki", keyPair.publicKey));
  const signatureHeader = toBase64(JSON.stringify({
    alg: "ECDSA",
    kid: "local-test-key",
    signature: toBase64(signature),
    digest: "SHA1",
  }));

  const valid = await verifyEbaySignature(signatureHeader, rawBody, async () => publicKeyPem);
  assert.equal(valid.verified, true);
  assert.equal(valid.error, null);

  const invalid = await verifyEbaySignature(signatureHeader, rawBody.replace("message-test-1", "message-test-2"), async () => publicKeyPem);
  assert.equal(invalid.verified, false);
  assert.equal(invalid.error, "signature_verification_failed");
});

test("receiver ledger path does not use partial-index-hostile upsert", async () => {
  const source = await fs.readFile(receiverPath, "utf8");
  assert.equal(source.includes(".upsert("), false);
  assert.equal(source.includes('onConflict: "notification_id"'), false);
  assert.match(source, /\.insert\(row\)/);
  assert.match(source, /error\.code === "23505"/);
});
