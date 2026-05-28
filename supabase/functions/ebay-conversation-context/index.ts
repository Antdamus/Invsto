import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildEbayConversationContext,
  EbayConversationContextError,
  linkEbayConversationContext,
  resolveEbayConversation,
} from "../_shared/ebay-conversation-context.ts";

type ServiceClient = ReturnType<typeof createClient>;
type Mode = "context" | "link_conversation" | "link_and_context";

type Input = {
  mode: Mode;
  conversationId: string | null;
  ebayConversationId: string | null;
  conversationType: string | null;
};

class FunctionError extends Error {
  code: string;
  status: number;
  phase: string;

  constructor(code: string, options: { status?: number; phase?: string; message?: string } = {}) {
    super(options.message || code);
    this.name = "FunctionError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "function";
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
  if (!value) throw new FunctionError("configuration_error", { phase: "configuration" });
  return value;
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function authenticatedClient(accessToken: string) {
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(requiredEnv("SUPABASE_URL"), anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

function stringOrNull(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient) {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new FunctionError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new FunctionError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new FunctionError("configuration_error", { phase: "employee_lookup" });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new FunctionError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

async function parseInput(req: Request): Promise<Input> {
  const body = await req.json().catch(() => ({}));
  const rawMode = stringOrNull(body?.mode) || "link_and_context";
  const mode = ["context", "link_conversation", "link_and_context"].includes(rawMode) ? rawMode as Mode : null;
  if (!mode) throw new FunctionError("invalid_mode", { status: 400, phase: "input" });
  const conversationId = stringOrNull(body?.conversationId || body?.conversation_id);
  const ebayConversationId = stringOrNull(body?.ebayConversationId || body?.ebay_conversation_id);
  if (!conversationId && !ebayConversationId) throw new FunctionError("conversation_id_required", { status: 400, phase: "input" });
  return {
    mode,
    conversationId,
    ebayConversationId,
    conversationType: stringOrNull(body?.conversationType || body?.conversation_type),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  const supabase = serviceClient();
  try {
    const accessToken = getBearerToken(req);
    const operator = await requireAdmin(req, supabase);
    const input = await parseInput(req);
    const conversation = await resolveEbayConversation(supabase, {
      conversationId: input.conversationId,
      ebayConversationId: input.ebayConversationId,
      conversationType: input.conversationType,
    });

    const linkResult = input.mode === "context"
      ? null
      : await linkEbayConversationContext(supabase, conversation.id);
    const context = input.mode === "link_conversation"
      ? null
      : await buildEbayConversationContext(
        supabase,
        conversation.id,
        operator.actorType === "admin" ? authenticatedClient(accessToken) : supabase,
      );

    return json(req, 200, {
      ok: true,
      mode: input.mode,
      conversation_id: conversation.id,
      ebay_conversation_id: conversation.ebay_conversation_id,
      link_result: linkResult,
      context,
      safety: {
        ebayMutationsPerformed: false,
        outlookMutationsPerformed: false,
        sendsEnabled: false,
        messagesSent: 0,
      },
    });
  } catch (error) {
    const known = error instanceof FunctionError || error instanceof EbayConversationContextError ? error : null;
    return json(req, known?.status || 500, {
      ok: false,
      error: known?.code || "unknown_error",
      phase: known?.phase || "unknown",
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      safety: {
        ebayMutationsPerformed: false,
        outlookMutationsPerformed: false,
        sendsEnabled: false,
        messagesSent: 0,
      },
    });
  }
});
