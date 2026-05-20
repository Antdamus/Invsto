import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ACTIVE_CONNECTION_STATUSES = ["connected", "error", "reconnect_required"];

type ServiceClient = ReturnType<typeof createClient>;

type MailboxConnection = {
  id: string;
  status: string;
};

class DisconnectError extends Error {
  code: string;
  status: number;
  phase: string;

  constructor(
    code: string,
    options: {
      status?: number;
      phase?: string;
    } = {},
  ) {
    super(code);
    this.name = "DisconnectError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "disconnect";
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
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new DisconnectError("disconnect_failed", {
      phase: "configuration",
    });
  }
  return value;
}

function serviceClient() {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request) {
  const supabase = serviceClient();
  const accessToken = getBearerToken(req);
  if (!accessToken) return { ok: false as const, status: 401, error: "unauthorized" };

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) return { ok: false as const, status: 401, error: "unauthorized" };

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) return { ok: false as const, status: 500, error: "disconnect_failed" };
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    return { ok: false as const, status: 403, error: "forbidden" };
  }

  return { ok: true as const, userId: user.id };
}

async function loadActiveConnection(supabase: ServiceClient): Promise<MailboxConnection | null> {
  const { data, error } = await supabase
    .from("microsoft_mailbox_connections")
    .select("id, status")
    .in("status", ACTIVE_CONNECTION_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(2);

  if (error) {
    throw new DisconnectError("disconnect_failed", {
      phase: "connection_lookup",
    });
  }

  if (!data?.length) return null;
  if (data.length > 1) {
    throw new DisconnectError("multiple_active_connections", {
      status: 409,
      phase: "connection_lookup",
    });
  }

  return data[0] as MailboxConnection;
}

async function disconnectMailbox(
  supabase: ServiceClient,
  connection: MailboxConnection,
  userId: string,
) {
  const nowIso = new Date().toISOString();

  const { error: deleteError } = await supabase
    .from("microsoft_mailbox_connection_secrets")
    .delete()
    .eq("connection_id", connection.id);

  if (deleteError) {
    throw new DisconnectError("disconnect_failed", {
      phase: "secret_delete",
    });
  }

  const { error: updateError } = await supabase
    .from("microsoft_mailbox_connections")
    .update({
      status: "disconnected",
      disconnected_at: nowIso,
      disconnected_by: userId,
      updated_at: nowIso,
      last_error_code: null,
      last_error_at: null,
    })
    .eq("id", connection.id)
    .in("status", ACTIVE_CONNECTION_STATUSES);

  if (updateError) {
    throw new DisconnectError("disconnect_failed", {
      phase: "connection_update",
    });
  }
}

function safeError(error: unknown) {
  if (error instanceof DisconnectError) return error;
  return new DisconnectError("disconnect_failed");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "disconnect_failed" });

  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const supabase = serviceClient();
    const connection = await loadActiveConnection(supabase);
    if (!connection) {
      return json(req, 200, { ok: false, error: "mailbox_not_connected" });
    }

    await disconnectMailbox(supabase, connection, admin.userId);

    console.log("[microsoft-mailbox-disconnect] mailbox disconnected", {
      phase: "disconnect",
      userId: admin.userId,
      connectionId: connection.id,
      previousStatus: connection.status,
    });

    return json(req, 200, {
      ok: true,
      disconnected: true,
    });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-mailbox-disconnect] failed", {
      phase: safe.phase,
      error: safe.code,
    });
    return json(req, safe.status, { ok: false, error: safe.code });
  }
});
