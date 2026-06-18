import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ServiceClient = ReturnType<typeof createClient>;
type JsonRecord = Record<string, unknown>;
type Operator = {
  actorType: "service_role" | "admin" | "email_triage";
  userId: string | null;
  email: string | null;
};

type ReadSyncInput = {
  mode: "set_read_state" | "process_pending_read";
  conversationId: string | null;
  read: boolean;
  limit: number;
  dryRun: boolean;
};

type ConversationRow = {
  id: string;
  seller_account_id: string;
  ebay_conversation_id: string;
  conversation_type: "FROM_MEMBERS" | "FROM_EBAY";
  unread_count: number | null;
  provider_read_state: string | null;
  local_read_state: string | null;
  pending_provider_update: boolean | null;
};

const DEFAULT_MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";

class ReadSyncError extends Error {
  code: string;
  status: number;
  phase: string;
  details: JsonRecord;

  constructor(code: string, options: { status?: number; phase?: string; message?: string; details?: JsonRecord } = {}) {
    super(options.message || code);
    this.name = "ReadSyncError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "read_sync";
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
  if (!value) throw new ReadSyncError("configuration_error", { status: 500, phase: "configuration" });
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
  if (!accessToken) throw new ReadSyncError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new ReadSyncError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active, email_triage_access")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new ReadSyncError("configuration_error", { status: 500, phase: "employee_lookup" });
  const role = String(employee?.role || "").toLowerCase();
  const canUseEmailTriage = employee?.active !== false && (role === "admin" || employee?.email_triage_access === true);
  if (!employee || !canUseEmailTriage) {
    throw new ReadSyncError("email_triage_access_required", { status: 403, phase: "auth" });
  }

  return { actorType: role === "admin" ? "admin" : "email_triage", userId: user.id, email: user.email || null };
}

async function parseInput(req: Request): Promise<ReadSyncInput> {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const mode = String(body?.mode || "set_read_state").trim();
  if (!["set_read_state", "process_pending_read"].includes(mode)) throw new ReadSyncError("invalid_mode", { status: 400, phase: "input" });

  if (mode === "process_pending_read") {
    return {
      mode: "process_pending_read",
      conversationId: null,
      read: true,
      limit: Math.min(Math.max(Number(body?.limit || 10) || 10, 1), 25),
      dryRun: body?.dryRun === true || body?.dry_run === true,
    };
  }

  const conversationId = String(body?.conversationId || body?.conversation_id || "").trim();
  if (!conversationId) throw new ReadSyncError("conversation_id_required", { status: 400, phase: "input" });

  const readState = String(body?.readState || body?.read_state || "").trim().toLowerCase();
  let read: boolean;
  if (typeof body?.read === "boolean") {
    read = body.read;
  } else if (readState === "read") {
    read = true;
  } else if (readState === "unread") {
    read = false;
  } else {
    throw new ReadSyncError("read_state_required", { status: 400, phase: "input" });
  }

  return {
    mode: "set_read_state",
    conversationId,
    read,
    limit: 1,
    dryRun: body?.dryRun === true || body?.dry_run === true,
  };
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

function ebayEnvironment() {
  const value = (Deno.env.get("EBAY_ENV") || "production").trim().toLowerCase();
  return value === "sandbox" ? "sandbox" : "production";
}

function ebayApiBase() {
  return ebayEnvironment() === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

async function refreshEbayToken(): Promise<string> {
  const clientId = optionalEnv("EBAY_CLIENT_ID", "EBAY_APP_ID");
  const clientSecret = optionalEnv("EBAY_CLIENT_SECRET", "EBAY_CERT_ID");
  const refreshToken = optionalEnv("EBAY_REFRESH_TOKEN");
  const scope = (Deno.env.get("EBAY_MESSAGE_SCOPE") || DEFAULT_MESSAGE_SCOPE).trim() || DEFAULT_MESSAGE_SCOPE;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new ReadSyncError("missing_ebay_oauth_secret", { status: 500, phase: "oauth" });
  }

  const res = await fetch(`${ebayApiBase()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope,
    }),
  });

  const payload = await parseResponse(res);
  if (!res.ok) {
    throw new ReadSyncError("ebay_oauth_refresh_failed", {
      status: 502,
      phase: "oauth",
      message: safeMessage(payload),
    });
  }

  const token = String((payload as JsonRecord).access_token || "").trim();
  if (!token) throw new ReadSyncError("ebay_oauth_missing_access_token", { status: 502, phase: "oauth" });
  return token;
}

async function loadConversation(supabase: ServiceClient, conversationId: string): Promise<ConversationRow> {
  const { data, error } = await supabase
    .from("ebay_conversations")
    .select("id, seller_account_id, ebay_conversation_id, conversation_type, unread_count, provider_read_state, local_read_state, pending_provider_update")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw new ReadSyncError("conversation_lookup_failed", { status: 500, phase: "database", message: error.message });
  if (!data?.id) throw new ReadSyncError("conversation_not_found", { status: 404, phase: "database" });
  return data as ConversationRow;
}

async function loadPendingReadConversations(supabase: ServiceClient, limit: number): Promise<ConversationRow[]> {
  const { data, error } = await supabase
    .from("ebay_conversations")
    .select("id, seller_account_id, ebay_conversation_id, conversation_type, unread_count, provider_read_state, local_read_state, pending_provider_update")
    .eq("pending_provider_update", true)
    .eq("local_read_state", "read")
    .neq("provider_read_state", "read")
    .order("last_local_read_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw new ReadSyncError("pending_read_queue_lookup_failed", { status: 500, phase: "database", message: error.message });
  return (data || []) as ConversationRow[];
}

async function updateProviderReadState(token: string, conversation: ConversationRow, read: boolean) {
  const res = await fetch(`${ebayApiBase()}/commerce/message/v1/update_conversation`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
    },
    body: JSON.stringify({
      conversationId: conversation.ebay_conversation_id,
      conversationType: conversation.conversation_type,
      read,
    }),
  });

  const payload = await parseResponse(res);
  if (!res.ok) {
    throw new ReadSyncError("ebay_update_conversation_failed", {
      status: 502,
      phase: "ebay_api",
      message: safeMessage(payload),
      details: {
        provider_response: {
          status: res.status,
          endpoint: "/commerce/message/v1/update_conversation",
          payload,
        },
      },
    });
  }
  return { status: res.status, payload };
}

async function recordReadActivity(options: {
  supabase: ServiceClient;
  operator: Operator;
  conversation: ConversationRow;
  eventType: "read_state_synced" | "read_state_sync_failed";
  status: "succeeded" | "failed";
  read: boolean;
  detail: string | null;
  metadata?: JsonRecord;
}) {
  const { error } = await options.supabase.rpc("record_ebay_message_activity_event", {
    _event_type: options.eventType,
    _status: options.status,
    _actor_user_id: options.operator.userId,
    _actor_email: options.operator.email,
    _conversation_id: options.conversation.id,
    _target_message_id: null,
    _draft_id: null,
    _approval_id: null,
    _send_attempt_id: null,
    _classification_id: null,
    _saved_view_id: null,
    _sync_run_id: null,
    _idempotency_key: `${options.eventType}:${options.conversation.id}:${options.read ? "read" : "unread"}:${Date.now()}`,
    _title: options.read ? "Provider marked read" : "Provider marked unread",
    _detail: options.detail,
    _metadata: {
      read_state: options.read ? "read" : "unread",
      ebay_conversation_id: options.conversation.ebay_conversation_id,
      conversation_type: options.conversation.conversation_type,
      safety: {
        ebay_mutation_performed: options.status === "succeeded",
        automatic_responses_sent: 0,
        sends_enabled: false,
        messages_sent: 0,
      },
      ...(options.metadata || {}),
    },
  });
  if (error) console.warn("[ebay-message-read-sync] activity event failed", error.message);
}

async function persistSuccess(supabase: ServiceClient, conversation: ConversationRow, read: boolean) {
  const state = read ? "read" : "unread";
  const unreadCount = read ? 0 : Math.max(Number(conversation.unread_count || 0), 1);
  const { error } = await supabase
    .from("ebay_conversations")
    .update({
      provider_read_state: state,
      local_read_state: state,
      pending_provider_update: false,
      unread_count: unreadCount,
      last_provider_seen_at: new Date().toISOString(),
      last_read_sync_at: new Date().toISOString(),
      read_sync_status: "synced",
      read_sync_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id);
  if (error) throw new ReadSyncError("conversation_read_state_update_failed", { status: 500, phase: "database", message: error.message });

  if (read) {
    await supabase
      .from("ebay_conversation_messages")
      .update({
        read_status: "Read",
        is_read: true,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", conversation.id);
  }
}

async function persistFailure(supabase: ServiceClient, conversationId: string, read: boolean, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 1000) : String(error || "Unknown error").slice(0, 1000);
  await supabase
    .from("ebay_conversations")
    .update({
      local_read_state: read ? "read" : "unread",
      pending_provider_update: true,
      read_sync_status: "provider_update_failed",
      read_sync_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  const supabase = serviceClient();
  let input: ReadSyncInput | null = null;
  let operator: Operator | null = null;
  let conversation: ConversationRow | null = null;

  try {
    operator = await requireAdmin(req, supabase);
    input = await parseInput(req);

    if (input.mode === "process_pending_read") {
      const pending = await loadPendingReadConversations(supabase, input.limit);
      if (input.dryRun) {
        return json(req, 200, {
          ok: true,
          mode: "process_pending_read",
          dryRun: true,
          queued: pending.length,
          conversations: pending.map((row) => ({
            conversationId: row.id,
            ebayConversationId: row.ebay_conversation_id,
            conversationType: row.conversation_type,
            providerReadState: row.provider_read_state,
            localReadState: row.local_read_state,
          })),
          safety: {
            readOnly: true,
            ebayMutationsPerformed: false,
            sendsEnabled: false,
            messagesSent: 0,
          },
        });
      }

      if (!pending.length) {
        return json(req, 200, {
          ok: true,
          mode: "process_pending_read",
          processed: 0,
          succeeded: 0,
          failed: 0,
          safety: {
            readOnly: false,
            ebayMutationsPerformed: false,
            sendsEnabled: false,
            messagesSent: 0,
          },
        });
      }

      const token = await refreshEbayToken();
      const results = [];
      for (const row of pending) {
        try {
          const providerResponse = await updateProviderReadState(token, row, true);
          await persistSuccess(supabase, row, true);
          await recordReadActivity({
            supabase,
            operator,
            conversation: row,
            eventType: "read_state_synced",
            status: "succeeded",
            read: true,
            detail: "Queued OG read state was automatically synced to eBay.",
            metadata: { provider_response: providerResponse, queue_mode: "process_pending_read" },
          });
          results.push({ conversationId: row.id, ok: true, providerResponse });
        } catch (error) {
          await persistFailure(supabase, row.id, true, error);
          await recordReadActivity({
            supabase,
            operator,
            conversation: row,
            eventType: "read_state_sync_failed",
            status: "failed",
            read: true,
            detail: error instanceof Error ? error.message.slice(0, 500) : String(error || "Provider read sync failed.").slice(0, 500),
            metadata: error instanceof ReadSyncError ? { ...error.details, queue_mode: "process_pending_read" } : { queue_mode: "process_pending_read" },
          });
          results.push({
            conversationId: row.id,
            ok: false,
            error: error instanceof ReadSyncError ? error.code : "unknown_error",
            message: error instanceof Error ? error.message : String(error || "Provider read sync failed."),
          });
        }
      }

      return json(req, 200, {
        ok: results.every((row) => row.ok),
        mode: "process_pending_read",
        processed: results.length,
        succeeded: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok).length,
        results,
        safety: {
          readOnly: false,
          ebayMutationsPerformed: results.some((row) => row.ok),
          sendsEnabled: false,
          messagesSent: 0,
        },
      });
    }

    if (!input.conversationId) throw new ReadSyncError("conversation_id_required", { status: 400, phase: "input" });
    conversation = await loadConversation(supabase, input.conversationId);

    if (input.dryRun) {
      return json(req, 200, {
        ok: true,
        mode: "set_read_state",
        dryRun: true,
        conversationId: conversation.id,
        ebayConversationId: conversation.ebay_conversation_id,
        conversationType: conversation.conversation_type,
        requestedReadState: input.read ? "read" : "unread",
        safety: {
          readOnly: true,
          ebayMutationsPerformed: false,
          sendsEnabled: false,
          messagesSent: 0,
        },
      });
    }

    const token = await refreshEbayToken();
    const providerResponse = await updateProviderReadState(token, conversation, input.read);
    await persistSuccess(supabase, conversation, input.read);
    await recordReadActivity({
      supabase,
      operator,
      conversation,
      eventType: "read_state_synced",
      status: "succeeded",
      read: input.read,
      detail: input.read ? "eBay conversation read state was updated to read." : "eBay conversation read state was updated to unread.",
      metadata: { provider_response: providerResponse },
    });

    return json(req, 200, {
      ok: true,
      mode: "set_read_state",
      conversationId: conversation.id,
      ebayConversationId: conversation.ebay_conversation_id,
      conversationType: conversation.conversation_type,
      providerReadState: input.read ? "read" : "unread",
      localReadState: input.read ? "read" : "unread",
      pendingProviderUpdate: false,
      providerResponse,
      safety: {
        readOnly: false,
        ebayMutationsPerformed: true,
        sendsEnabled: false,
        messagesSent: 0,
      },
    });
  } catch (error) {
    if (input?.mode === "set_read_state" && input?.conversationId) await persistFailure(supabase, input.conversationId, input.read, error);
    if (operator && conversation && input) {
      await recordReadActivity({
        supabase,
        operator,
        conversation,
        eventType: "read_state_sync_failed",
        status: "failed",
        read: input.read,
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error || "Provider read sync failed.").slice(0, 500),
        metadata: error instanceof ReadSyncError ? error.details : {},
      });
    }
    const status = error instanceof ReadSyncError ? error.status : 500;
    return json(req, status, {
      ok: false,
      mode: input?.mode || "set_read_state",
      error: error instanceof ReadSyncError ? error.code : "unknown_error",
      phase: error instanceof ReadSyncError ? error.phase : "unknown",
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      details: error instanceof ReadSyncError ? error.details : {},
      safety: {
        readOnly: false,
        ebayMutationsPerformed: false,
        sendsEnabled: false,
        messagesSent: 0,
      },
    });
  }
});
