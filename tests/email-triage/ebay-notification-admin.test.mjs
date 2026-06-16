import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminFunctionPath = path.join(repoRoot, "supabase/functions/ebay-notification-admin/index.ts");
const oauthCallbackPath = path.join(repoRoot, "supabase/functions/ebay-oauth-callback/index.ts");
const supabaseConfigPath = path.join(repoRoot, "supabase/config.toml");

test("notification admin function is configured as JWT-protected", async () => {
  const config = await fs.readFile(supabaseConfigPath, "utf8");
  assert.match(config, /\[functions\.ebay-notification-admin\][\s\S]*?verify_jwt = true/);
  assert.match(config, /entrypoint = "\.\/functions\/ebay-notification-admin\/index\.ts"/);
});

test("notification admin function keeps activation guarded and message-safe", async () => {
  const source = await fs.readFile(adminFunctionPath, "utf8");
  assert.match(source, /CONFIRM_MUTATION = "I_UNDERSTAND_THIS_CONFIGURES_EBAY_NOTIFICATIONS"/);
  assert.match(source, /apply_required/);
  assert.match(source, /confirmation_required/);
  assert.match(source, /requireAdmin/);
  assert.match(source, /commerce\.notification\.subscription/);
  assert.match(source, /commerce\.message/);
  assert.match(source, /\/commerce\/notification\/v1\/subscription/);
  assert.match(source, /idFromResult/);
  assert.match(source, /destinationId", "destination_id", "id"/);
  assert.match(source, /subscriptionId", "subscription_id", "id"/);
  assert.equal(source.includes("/commerce/message/v1/send_message"), false);
});

test("oauth callback default consent scopes include messaging and notification subscription", async () => {
  const source = await fs.readFile(oauthCallbackPath, "utf8");
  assert.match(source, /https:\/\/api\.ebay\.com\/oauth\/api_scope\/commerce\.message/);
  assert.match(source, /https:\/\/api\.ebay\.com\/oauth\/api_scope\/commerce\.notification\.subscription/);
});
