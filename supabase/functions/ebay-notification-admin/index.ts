import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type ServiceClient = ReturnType<typeof createClient>;
type Operator = {
  actorType: "service_role" | "admin";
  userId: string | null;
  email: string | null;
};
type AdminMode =
  | "audit"
  | "ensure_config"
  | "ensure_destination"
  | "ensure_subscription"
  | "test_subscription"
  | "enable_subscription"
  | "activate";
type Input = {
  mode: AdminMode;
  apply: boolean;
  confirm: string;
  alertEmail: string | null;
  destinationName: string;
  endpoint: string;
  verificationToken: string;
  topicId: string;
  subscriptionId: string | null;
  destinationId: string | null;
  enable: boolean;
};

const DEFAULT_TOPIC_ID = "NEW_MESSAGE";
const DEFAULT_BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const DEFAULT_USER_SUBSCRIPTION_SCOPE = [
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
  "https://api.ebay.com/oauth/api_scope/commerce.message",
].join(" ");
const CONFIRM_MUTATION = "I_UNDERSTAND_THIS_CONFIGURES_EBAY_NOTIFICATIONS";

class AdminError extends Error {
  code: string;
  status: number;
  phase: string;
  details: JsonRecord;

  constructor(code: string, options: { status?: number; phase?: string; message?: string; details?: JsonRecord } = {}) {
    super(options.message || code);
    this.name = "AdminError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "admin";
    this.details = options.details || {};
  }
}

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
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new AdminError("configuration_error", { status: 500, phase: "configuration", message: `Missing ${name}.` });
  return value;
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient): Promise<Operator> {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new AdminError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new AdminError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new AdminError("configuration_error", { status: 500, phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new AdminError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

function text(value: unknown) {
  return String(value || "").trim();
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function safeErrorPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as JsonRecord;
  return {
    error: record.error,
    error_description: record.error_description,
    message: record.message,
    errors: Array.isArray(record.errors)
      ? record.errors.slice(0, 5).map((entry) => {
        const item = recordOrEmpty(entry);
        return {
          errorId: item.errorId,
          domain: item.domain,
          category: item.category,
          message: item.message,
          longMessage: item.longMessage,
        };
      })
      : undefined,
  };
}

function safeMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return String(payload || "").slice(0, 500);
  const record = payload as JsonRecord;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const firstError = errors.find((entry) => entry && typeof entry === "object") as JsonRecord | undefined;
  const parts = [
    record.error,
    record.error_description,
    record.message,
    firstError?.message,
    firstError?.longMessage,
    firstError?.errorId ? `errorId:${firstError.errorId}` : "",
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return (parts.join(" | ") || "Unknown eBay error").slice(0, 500);
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

async function oauthToken(options: { grant: "client_credentials" | "refresh_token"; scope: string }) {
  const clientId = optionalEnv("EBAY_CLIENT_ID", "EBAY_APP_ID");
  const clientSecret = optionalEnv("EBAY_CLIENT_SECRET", "EBAY_CERT_ID");
  if (!clientId || !clientSecret) {
    throw new AdminError("missing_ebay_oauth_client_secret", { status: 500, phase: "oauth" });
  }

  const body = new URLSearchParams({
    grant_type: options.grant,
    scope: options.scope,
  });
  if (options.grant === "refresh_token") {
    const refreshToken = optionalEnv("EBAY_REFRESH_TOKEN");
    if (!refreshToken) throw new AdminError("missing_ebay_refresh_token", { status: 500, phase: "oauth" });
    body.set("refresh_token", refreshToken);
  }

  const res = await fetch(`${ebayApiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await parseResponse(res);
  if (!res.ok) {
    throw new AdminError("ebay_oauth_failed", {
      status: 502,
      phase: "oauth",
      message: safeMessage(payload),
      details: {
        grant: options.grant,
        scope: options.scope,
        ebay_status: res.status,
        ebay_error_payload: safeErrorPayload(payload),
      },
    });
  }

  const token = text((payload as JsonRecord).access_token);
  if (!token) throw new AdminError("ebay_oauth_missing_access_token", { status: 502, phase: "oauth" });
  return {
    token,
    expiresIn: Number((payload as JsonRecord).expires_in || 0) || null,
    scope: text((payload as JsonRecord).scope) || options.scope,
  };
}

async function ebayRequest(token: string, options: {
  method: string;
  path: string;
  body?: JsonRecord;
  okStatuses?: number[];
}) {
  const res = await fetch(`${ebayApiBase()}${options.path}`, {
    method: options.method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await parseResponse(res);
  const okStatuses = options.okStatuses || [200, 201, 204];
  if (!okStatuses.includes(res.status)) {
    throw new AdminError("ebay_notification_api_failed", {
      status: 502,
      phase: "ebay_notification_api",
      message: safeMessage(payload),
      details: {
        method: options.method,
        path: options.path,
        ebay_status: res.status,
        ebay_error_payload: safeErrorPayload(payload),
      },
    });
  }
  return {
    status: res.status,
    payload,
    location: res.headers.get("Location") || res.headers.get("location") || null,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function configuredEndpoint() {
  return optionalEnv("EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL") ||
    `${requiredEnv("SUPABASE_URL").replace(/\/+$/, "")}/functions/v1/ebay-message-notification`;
}

async function challengeProbe(endpoint: string, verificationToken: string) {
  if (!endpoint || !verificationToken) {
    return {
      ok: false,
      status: null,
      error: "missing_endpoint_or_verification_token",
      challengeResponseMatches: false,
    };
  }
  const challengeCode = `og-subscription-audit-${Date.now()}`;
  const expected = await sha256Hex(`${challengeCode}${verificationToken}${endpoint}`);
  try {
    const res = await fetch(`${endpoint}?challenge_code=${encodeURIComponent(challengeCode)}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const payload = await parseResponse(res);
    const actual = text((payload as JsonRecord).challengeResponse);
    return {
      ok: res.status === 200 && actual === expected,
      status: res.status,
      challengeResponseMatches: actual === expected,
      challengeResponseLength: actual.length,
      error: res.status === 200 ? null : safeMessage(payload),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      challengeResponseMatches: false,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error || "challenge_probe_failed").slice(0, 500),
    };
  }
}

function listFromPayload(payload: unknown, keys: string[]) {
  const record = recordOrEmpty(payload);
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value as JsonRecord[];
  }
  return [];
}

function idFromLocation(location: string | null) {
  if (!location) return null;
  return location.split("/").filter(Boolean).at(-1) || null;
}

function idFromResult(result: { payload: unknown; location: string | null }, keys: string[]) {
  const payload = recordOrEmpty(result.payload);
  for (const key of keys) {
    const value = text(payload[key]);
    if (value) return value;
  }
  return idFromLocation(result.location);
}

function destinationId(row: JsonRecord) {
  return text(row.destinationId) || text(row.destination_id) || text(row.id);
}

function subscriptionId(row: JsonRecord) {
  return text(row.subscriptionId) || text(row.subscription_id) || text(row.id);
}

function destinationEndpoint(row: JsonRecord) {
  const deliveryConfig = recordOrEmpty(row.deliveryConfig);
  const delivery_config = recordOrEmpty(row.delivery_config);
  return text(deliveryConfig.endpoint) || text(delivery_config.endpoint) || text(row.endpoint);
}

function destinationStatus(row: JsonRecord) {
  return text(row.status || row.destinationStatus || row.destination_status).toUpperCase();
}

function subscriptionStatus(row: JsonRecord) {
  return text(row.status || row.subscriptionStatus || row.subscription_status).toUpperCase();
}

function topicSchemaVersion(topicPayload: unknown) {
  const supported = listFromPayload(topicPayload, ["supportedPayloads", "supported_payloads"]);
  const active = supported.find((payload) => {
    const protocols = Array.isArray(payload.format) ? payload.format : [payload.format];
    return text(payload.deliveryProtocol).toUpperCase() === "HTTPS" &&
      protocols.map((value) => text(value).toUpperCase()).includes("JSON") &&
      payload.deprecated !== true;
  }) || supported[0];
  return text(active?.schemaVersion) || "1.0";
}

function subscriptionMatches(row: JsonRecord, topicId: string, destinationIdValue?: string | null) {
  if (text(row.topicId || row.topic_id).toUpperCase() !== topicId.toUpperCase()) return false;
  if (!destinationIdValue) return true;
  return text(row.destinationId || row.destination_id) === destinationIdValue;
}

function parseInput(body: JsonRecord): Input {
  const mode = text(body.mode || "audit") as AdminMode;
  const allowed: AdminMode[] = [
    "audit",
    "ensure_config",
    "ensure_destination",
    "ensure_subscription",
    "test_subscription",
    "enable_subscription",
    "activate",
  ];
  if (!allowed.includes(mode)) throw new AdminError("invalid_mode", { status: 400, phase: "input" });

  return {
    mode,
    apply: body.apply === true,
    confirm: text(body.confirm),
    alertEmail: text(body.alertEmail || body.alert_email || optionalEnv("EBAY_NOTIFICATION_ALERT_EMAIL")) || null,
    destinationName: text(body.destinationName || body.destination_name || "og-ebay-message-notification"),
    endpoint: text(body.endpoint || configuredEndpoint()),
    verificationToken: text(body.verificationToken || body.verification_token || optionalEnv("EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN")),
    topicId: text(body.topicId || body.topic_id || DEFAULT_TOPIC_ID),
    subscriptionId: text(body.subscriptionId || body.subscription_id) || null,
    destinationId: text(body.destinationId || body.destination_id) || null,
    enable: body.enable === true || mode === "enable_subscription" || mode === "activate",
  };
}

function assertMutationAllowed(input: Input) {
  if (input.mode === "audit") return;
  if (!input.apply) {
    throw new AdminError("apply_required", {
      status: 400,
      phase: "input",
      message: "Set apply=true to change eBay notification configuration.",
    });
  }
  if (input.confirm !== CONFIRM_MUTATION) {
    throw new AdminError("confirmation_required", {
      status: 400,
      phase: "input",
      message: `Set confirm=${CONFIRM_MUTATION}.`,
    });
  }
}

async function notificationAudit(input: Input) {
  const appScope = (Deno.env.get("EBAY_NOTIFICATION_SCOPE") || DEFAULT_BASE_SCOPE).trim() || DEFAULT_BASE_SCOPE;
  const userScope = (Deno.env.get("EBAY_NOTIFICATION_SUBSCRIPTION_SCOPE") || DEFAULT_USER_SUBSCRIPTION_SCOPE).trim() || DEFAULT_USER_SUBSCRIPTION_SCOPE;
  const audit: JsonRecord = {
    environment: ebayEnvironment(),
    endpoint: input.endpoint,
    topicId: input.topicId,
    scopes: {
      app: appScope,
      userSubscription: userScope,
    },
    appToken: { ok: false },
    userSubscriptionToken: { ok: false },
    config: null,
    topic: null,
    destinations: [],
    matchingDestination: null,
    subscriptions: [],
    matchingSubscription: null,
    challenge: await challengeProbe(input.endpoint, input.verificationToken),
  };

  let appToken = "";
  try {
    const token = await oauthToken({ grant: "client_credentials", scope: appScope });
    appToken = token.token;
    audit.appToken = { ok: true, expiresIn: token.expiresIn, scope: token.scope };
    const [config, topic, destinations] = await Promise.all([
      ebayRequest(appToken, { method: "GET", path: "/commerce/notification/v1/config", okStatuses: [200, 404] })
        .catch((error) => ({ error })),
      ebayRequest(appToken, { method: "GET", path: `/commerce/notification/v1/topic/${encodeURIComponent(input.topicId)}` })
        .catch((error) => ({ error })),
      ebayRequest(appToken, { method: "GET", path: "/commerce/notification/v1/destination" })
        .catch((error) => ({ error })),
    ]);
    audit.config = "error" in config ? { ok: false, error: config.error instanceof Error ? config.error.message : String(config.error) } : config.payload;
    audit.topic = "error" in topic ? { ok: false, error: topic.error instanceof Error ? topic.error.message : String(topic.error) } : topic.payload;
    const destinationRows = "error" in destinations
      ? []
      : listFromPayload(destinations.payload, ["destinations", "destination"]);
    audit.destinations = destinationRows.map((row) => ({
      destinationId: destinationId(row),
      name: text(row.name),
      status: destinationStatus(row),
      endpoint: destinationEndpoint(row),
    }));
    audit.matchingDestination = (audit.destinations as JsonRecord[]).find((row) => text(row.endpoint) === input.endpoint) || null;
  } catch (error) {
    audit.appToken = {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error || "app_token_failed").slice(0, 500),
      details: error instanceof AdminError ? error.details : {},
    };
  }

  try {
    const token = await oauthToken({ grant: "refresh_token", scope: userScope });
    audit.userSubscriptionToken = { ok: true, expiresIn: token.expiresIn, scope: token.scope };
    const subscriptions = await ebayRequest(token.token, { method: "GET", path: "/commerce/notification/v1/subscription" });
    const destination = recordOrEmpty(audit.matchingDestination);
    const destinationIdValue = input.destinationId || text(destination.destinationId) || null;
    const subscriptionRows = listFromPayload(subscriptions.payload, ["subscriptions", "subscription"]);
    audit.subscriptions = subscriptionRows.map((row) => ({
      subscriptionId: subscriptionId(row),
      topicId: text(row.topicId || row.topic_id),
      status: subscriptionStatus(row),
      destinationId: text(row.destinationId || row.destination_id),
      payload: recordOrEmpty(row.payload),
    }));
    audit.matchingSubscription = (audit.subscriptions as JsonRecord[])
      .find((row) => subscriptionMatches(row, input.topicId, destinationIdValue)) || null;
  } catch (error) {
    audit.userSubscriptionToken = {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error || "user_subscription_token_failed").slice(0, 500),
      details: error instanceof AdminError ? error.details : {},
    };
  }

  const topic = recordOrEmpty(audit.topic);
  const matchingDestination = recordOrEmpty(audit.matchingDestination);
  const matchingSubscription = recordOrEmpty(audit.matchingSubscription);
  const topicEnabled = text(topic.status).toUpperCase() === "ENABLED";
  const destinationEnabled = destinationStatus(matchingDestination) === "ENABLED";
  const subscriptionEnabled = subscriptionStatus(matchingSubscription) === "ENABLED";
  audit.capability = {
    canSubscribeToday: Boolean(
      recordOrEmpty(audit.appToken).ok === true &&
      recordOrEmpty(audit.userSubscriptionToken).ok === true &&
      topicEnabled &&
      recordOrEmpty(audit.challenge).ok === true
    ),
    liveDeliveryActive: Boolean(destinationEnabled && subscriptionEnabled),
    topicEnabled,
    destinationConfigured: Boolean(text(matchingDestination.destinationId)),
    destinationEnabled,
    subscriptionConfigured: Boolean(text(matchingSubscription.subscriptionId)),
    subscriptionEnabled,
    blockers: [
      recordOrEmpty(audit.appToken).ok === true ? "" : "App client-credentials token failed.",
      recordOrEmpty(audit.userSubscriptionToken).ok === true ? "" : "Seller refresh token cannot mint commerce.notification.subscription plus commerce.message.",
      topicEnabled ? "" : `${input.topicId} topic is not ENABLED.`,
      recordOrEmpty(audit.challenge).ok === true ? "" : "Webhook challenge probe failed.",
      text(matchingDestination.destinationId) ? "" : "Destination is not configured.",
      destinationEnabled || !text(matchingDestination.destinationId) ? "" : "Destination exists but is not ENABLED.",
      text(matchingSubscription.subscriptionId) ? "" : "Subscription is not configured.",
      subscriptionEnabled || !text(matchingSubscription.subscriptionId) ? "" : "Subscription exists but is not ENABLED.",
    ].filter(Boolean),
  };

  return audit;
}

async function ensureConfig(input: Input, appToken: string) {
  if (!input.alertEmail) return { skipped: true, reason: "No alert email configured." };
  return ebayRequest(appToken, {
    method: "PUT",
    path: "/commerce/notification/v1/config",
    body: { alertEmail: input.alertEmail },
    okStatuses: [204],
  });
}

async function ensureDestination(input: Input, appToken: string, audit: JsonRecord) {
  const matching = recordOrEmpty(audit.matchingDestination);
  const existingId = text(matching.destinationId) || input.destinationId;
  const body = {
    name: input.destinationName,
    status: "ENABLED",
    deliveryConfig: {
      endpoint: input.endpoint,
      verificationToken: input.verificationToken,
    },
  };
  if (existingId) {
    const result = await ebayRequest(appToken, {
      method: "PUT",
      path: `/commerce/notification/v1/destination/${encodeURIComponent(existingId)}`,
      body,
      okStatuses: [204],
    });
    return { ...result, destinationId: existingId, updated: true };
  }
  const result = await ebayRequest(appToken, {
    method: "POST",
    path: "/commerce/notification/v1/destination",
    body,
    okStatuses: [201, 204],
  });
  return { ...result, destinationId: idFromResult(result, ["destinationId", "destination_id", "id"]), created: true };
}

async function ensureSubscription(input: Input, userToken: string, audit: JsonRecord, destinationIdValue: string) {
  const matching = recordOrEmpty(audit.matchingSubscription);
  const existingId = text(matching.subscriptionId) || input.subscriptionId;
  const schemaVersion = topicSchemaVersion(audit.topic);
  const body = {
    topicId: input.topicId,
    status: input.enable ? "ENABLED" : "DISABLED",
    destinationId: destinationIdValue,
    payload: {
      format: "JSON",
      schemaVersion,
      deliveryProtocol: "HTTPS",
    },
  };
  if (existingId) {
    const result = await ebayRequest(userToken, {
      method: "PUT",
      path: `/commerce/notification/v1/subscription/${encodeURIComponent(existingId)}`,
      body,
      okStatuses: [204],
    });
    return { ...result, subscriptionId: existingId, updated: true, schemaVersion };
  }
  const result = await ebayRequest(userToken, {
    method: "POST",
    path: "/commerce/notification/v1/subscription",
    body,
    okStatuses: [201, 204],
  });
  return { ...result, subscriptionId: idFromResult(result, ["subscriptionId", "subscription_id", "id"]), created: true, schemaVersion };
}

async function runMutation(input: Input) {
  assertMutationAllowed(input);
  const appScope = (Deno.env.get("EBAY_NOTIFICATION_SCOPE") || DEFAULT_BASE_SCOPE).trim() || DEFAULT_BASE_SCOPE;
  const userScope = (Deno.env.get("EBAY_NOTIFICATION_SUBSCRIPTION_SCOPE") || DEFAULT_USER_SUBSCRIPTION_SCOPE).trim() || DEFAULT_USER_SUBSCRIPTION_SCOPE;
  const appToken = await oauthToken({ grant: "client_credentials", scope: appScope });
  const userToken = await oauthToken({ grant: "refresh_token", scope: userScope });
  const initialAudit = await notificationAudit(input);
  const actions: JsonRecord = {};

  if (input.mode === "ensure_config" || input.mode === "activate") {
    actions.config = await ensureConfig(input, appToken.token);
  }

  if (input.mode === "ensure_destination" || input.mode === "activate") {
    actions.destination = await ensureDestination(input, appToken.token, initialAudit);
  }

  const destinationIdValue = input.destinationId ||
    text(recordOrEmpty(actions.destination).destinationId) ||
    text(recordOrEmpty(initialAudit.matchingDestination).destinationId);

  if ((input.mode === "ensure_subscription" || input.mode === "activate") && !destinationIdValue) {
    throw new AdminError("destination_id_required", {
      status: 400,
      phase: "input",
      message: "Create or provide a destination before creating the subscription.",
    });
  }

  if (input.mode === "ensure_subscription" || input.mode === "activate") {
    actions.subscription = await ensureSubscription(input, userToken.token, initialAudit, destinationIdValue);
  }

  const subscriptionIdValue = input.subscriptionId ||
    text(recordOrEmpty(actions.subscription).subscriptionId) ||
    text(recordOrEmpty(initialAudit.matchingSubscription).subscriptionId);

  if (input.mode === "test_subscription" || input.mode === "activate") {
    if (!subscriptionIdValue) throw new AdminError("subscription_id_required", { status: 400, phase: "input" });
    actions.test = await ebayRequest(userToken.token, {
      method: "POST",
      path: `/commerce/notification/v1/subscription/${encodeURIComponent(subscriptionIdValue)}/test`,
      okStatuses: [200, 202, 204],
    });
  }

  if (input.mode === "enable_subscription" || input.mode === "activate") {
    if (!subscriptionIdValue) throw new AdminError("subscription_id_required", { status: 400, phase: "input" });
    actions.enable = await ebayRequest(userToken.token, {
      method: "POST",
      path: `/commerce/notification/v1/subscription/${encodeURIComponent(subscriptionIdValue)}/enable`,
      okStatuses: [200, 204],
    });
  }

  return {
    ok: true,
    mode: input.mode,
    environment: ebayEnvironment(),
    actions,
    audit: await notificationAudit(input),
    safety: {
      ebayNotificationConfigurationMutated: true,
      ebayMessageMutationPerformed: false,
      sendsEnabled: false,
      messagesSent: 0,
    },
  };
}

async function recordActivity(options: {
  supabase: ServiceClient;
  operator: Operator;
  input: Input;
  status: "succeeded" | "failed";
  metadata: JsonRecord;
}) {
  const { error } = await options.supabase.rpc("record_ebay_message_activity_event", {
    _event_type: "provider_notification_received",
    _status: options.status,
    _actor_user_id: options.operator.userId,
    _actor_email: options.operator.email,
    _conversation_id: null,
    _target_message_id: null,
    _draft_id: null,
    _approval_id: null,
    _send_attempt_id: null,
    _classification_id: null,
    _saved_view_id: null,
    _sync_run_id: null,
    _idempotency_key: `ebay_notification_admin:${options.input.mode}:${Date.now()}`,
    _title: "eBay notification configuration audited",
    _detail: options.input.topicId,
    _metadata: {
      mode: options.input.mode,
      apply: options.input.apply,
      topic_id: options.input.topicId,
      endpoint: options.input.endpoint,
      ...options.metadata,
      safety: {
        ebay_notification_configuration_mutated: options.input.apply && options.status === "succeeded" && options.input.mode !== "audit",
        ebay_message_mutation_performed: false,
        automatic_responses_sent: 0,
        sends_enabled: false,
        messages_sent: 0,
      },
    },
  });
  if (error) console.warn("[ebay-notification-admin] activity event failed", error.message);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  const supabase = serviceClient();
  let operator: Operator | null = null;
  let input: Input | null = null;
  try {
    operator = await requireAdmin(req, supabase);
    input = parseInput(recordOrEmpty(await req.json().catch(() => ({}))));

    const result = input.mode === "audit"
      ? {
        ok: true,
        mode: input.mode,
        audit: await notificationAudit(input),
        safety: {
          ebayNotificationConfigurationMutated: false,
          ebayMessageMutationPerformed: false,
          sendsEnabled: false,
          messagesSent: 0,
        },
      }
      : await runMutation(input);

    await recordActivity({
      supabase,
      operator,
      input,
      status: "succeeded",
      metadata: { result_summary: recordOrEmpty(result).safety || {} },
    });
    return json(req, 200, result);
  } catch (error) {
    if (operator && input) {
      await recordActivity({
        supabase,
        operator,
        input,
        status: "failed",
        metadata: {
          error: error instanceof Error ? error.message.slice(0, 500) : String(error || "failed").slice(0, 500),
          details: error instanceof AdminError ? error.details : {},
        },
      });
    }
    const status = error instanceof AdminError ? error.status : 500;
    return json(req, status, {
      ok: false,
      mode: input?.mode || "unknown",
      error: error instanceof AdminError ? error.code : "unknown_error",
      phase: error instanceof AdminError ? error.phase : "unknown",
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      details: error instanceof AdminError ? error.details : {},
      safety: {
        ebayNotificationConfigurationMutated: false,
        ebayMessageMutationPerformed: false,
        sendsEnabled: false,
        messagesSent: 0,
      },
    });
  }
});
