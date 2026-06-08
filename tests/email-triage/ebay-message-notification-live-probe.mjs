import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, "");
    if (value) out[match[1]] = value;
  }
  return out;
}

function loadEnv() {
  return {
    ...parseEnvFile(path.join(repoRoot, ".env.email-triage")),
    ...parseEnvFile(path.join(repoRoot, ".env.local")),
    ...parseEnvFile(path.join(repoRoot, ".env.codex")),
    ...parseEnvFile(path.join(repoRoot, "tests/email-triage/.env.local")),
    ...parseEnvFile(path.join(repoRoot, "tests/email-triage/.env.codex")),
    ...process.env,
  };
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function selectNotification({ supabaseUrl, serviceKey, notificationId }) {
  const url = new URL(`${supabaseUrl}/rest/v1/ebay_message_notifications`);
  url.searchParams.set("select", "id,notification_id,publish_attempt_count,processing_status,signature_verified,signature_verification_error");
  url.searchParams.set("notification_id", `eq.${notificationId}`);
  const response = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  return { response, rows: await readJson(response) };
}

async function postUnsignedNotification({ endpoint, notificationId, publishAttemptCount }) {
  const now = new Date().toISOString();
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: { topic: "NEW_MESSAGE", schemaVersion: "1.0", deprecated: false },
      notification: {
        notificationId,
        eventDate: now,
        publishDate: now,
        publishAttemptCount,
        data: {
          conversationId: "125786456410",
          conversationType: "FROM_MEMBERS",
          messageId: "codex-synthetic-message",
          readStatus: false,
        },
      },
    }),
  });
}

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

const env = loadEnv();
const supabaseUrl = String(env.SUPABASE_URL || env.EMAIL_TRIAGE_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
assert(supabaseUrl, "Missing SUPABASE_URL for live notification probe.");
assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY for live notification probe.");

const endpoint = `${supabaseUrl}/functions/v1/ebay-message-notification`;
const challengeCode = `codex-live-probe-${Date.now()}`;
const challengeResponse = await fetch(`${endpoint}?challenge_code=${encodeURIComponent(challengeCode)}`);
const challengePayload = await readJson(challengeResponse);
assert(challengeResponse.status === 200, "Challenge probe failed.", {
  status: challengeResponse.status,
  payload: challengePayload,
});
assert(String(challengePayload.challengeResponse || "").length === 64, "Challenge response was not a SHA-256 hex digest.", {
  payload: challengePayload,
});

const notificationId = `codex-live-ledger-${Date.now()}-${crypto.randomUUID()}`;
const before = await selectNotification({ supabaseUrl, serviceKey, notificationId });
assert(before.response.status === 200, "Initial ledger query failed.", { status: before.response.status });
assert(Array.isArray(before.rows) && before.rows.length === 0, "Synthetic notification ID already existed.", { rows: before.rows });

const firstPost = await postUnsignedNotification({ endpoint, notificationId, publishAttemptCount: 1 });
const firstPayload = await readJson(firstPost);
assert(firstPost.status === 412, "Unsigned notification should be rejected.", {
  status: firstPost.status,
  payload: firstPayload,
});
assert(firstPayload.error === "signature_verification_failed", "Unsigned notification returned an unexpected error.", {
  payload: firstPayload,
});

const secondPost = await postUnsignedNotification({ endpoint, notificationId, publishAttemptCount: 2 });
const secondPayload = await readJson(secondPost);
assert(secondPost.status === 412, "Duplicate unsigned notification should still be rejected.", {
  status: secondPost.status,
  payload: secondPayload,
});

await new Promise((resolve) => setTimeout(resolve, 1000));
const after = await selectNotification({ supabaseUrl, serviceKey, notificationId });
assert(after.response.status === 200, "Final ledger query failed.", { status: after.response.status });
assert(Array.isArray(after.rows) && after.rows.length === 1, "Ledger row was not persisted idempotently.", {
  rows: after.rows,
});
const row = after.rows[0];
assert(row.processing_status === "signature_failed", "Ledger row should be marked signature_failed.", { row });
assert(row.signature_verified === false, "Ledger row should record signature_verified=false.", { row });
assert(row.signature_verification_error === "missing_x_ebay_signature", "Ledger row should preserve signature error.", { row });
assert(row.publish_attempt_count === 2, "Duplicate notification should update the existing ledger row.", { row });

console.log(JSON.stringify({
  endpoint,
  challenge: {
    status: challengeResponse.status,
    challengeResponseLength: String(challengePayload.challengeResponse || "").length,
  },
  unsignedNotification: {
    firstStatus: firstPost.status,
    secondStatus: secondPost.status,
    firstError: firstPayload.error || null,
    secondError: secondPayload.error || null,
  },
  ledger: {
    beforeCount: before.rows.length,
    afterCount: after.rows.length,
    row,
  },
  safety: {
    eBayMutationPerformed: false,
    sendsEnabled: false,
    messagesSent: 0,
  },
}, null, 2));
