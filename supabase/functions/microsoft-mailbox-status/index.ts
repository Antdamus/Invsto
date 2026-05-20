import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ACTIVE_CONNECTION_STATUSES = ["connected", "error", "reconnect_required"];
const SAFE_CONNECTION_STATUSES = new Set([
  "connected",
  "error",
  "reconnect_required",
  "disconnected",
]);

type ServiceClient = ReturnType<typeof createClient>;

type MailboxConnectionRow = {
  id: string;
  mailbox_email: string;
  display_name: string | null;
  status: string;
  connected_at: string;
  updated_at: string;
  last_successful_check_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  access_token_expires_at: string | null;
  scopes: string[] | null;
  tenant_id_or_authority: string;
};

class MailboxStatusError extends Error {
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
    this.name = "MailboxStatusError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "mailbox_status";
  }
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    throw new MailboxStatusError("configuration_error", {
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

  if (employeeError) return { ok: false as const, status: 500, error: "status_lookup_failed" };
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    return { ok: false as const, status: 403, error: "admin_required" };
  }

  return { ok: true as const, userId: user.id };
}

function sanitizeConnection(row: MailboxConnectionRow) {
  return {
    id: row.id,
    mailbox_email: row.mailbox_email,
    display_name: row.display_name,
    status: row.status,
    connected_at: row.connected_at,
    updated_at: row.updated_at,
    last_successful_check_at: row.last_successful_check_at,
    last_error_code: row.last_error_code,
    last_error_at: row.last_error_at,
    access_token_expires_at: row.access_token_expires_at,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    tenant_id_or_authority: row.tenant_id_or_authority,
  };
}

async function loadActiveConnection(supabase: ServiceClient) {
  const { data, error } = await supabase
    .from("microsoft_mailbox_connections")
    .select([
      "id",
      "mailbox_email",
      "display_name",
      "status",
      "connected_at",
      "updated_at",
      "last_successful_check_at",
      "last_error_code",
      "last_error_at",
      "access_token_expires_at",
      "scopes",
      "tenant_id_or_authority",
    ].join(", "))
    .in("status", ACTIVE_CONNECTION_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(2);

  if (error) {
    throw new MailboxStatusError("status_lookup_failed", {
      phase: "connection_lookup",
    });
  }

  if (!data?.length) return null;
  if (data.length > 1) {
    throw new MailboxStatusError("multiple_active_connections", {
      status: 409,
      phase: "connection_lookup",
    });
  }

  const row = data[0] as MailboxConnectionRow;
  if (!SAFE_CONNECTION_STATUSES.has(row.status)) {
    throw new MailboxStatusError("unexpected_status_error", {
      phase: "connection_sanitize",
    });
  }

  return sanitizeConnection(row);
}

function safeError(error: unknown) {
  if (error instanceof MailboxStatusError) return error;
  return new MailboxStatusError("unexpected_status_error");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, 200, { ok: true });
  if (!["GET", "POST"].includes(req.method)) {
    return json(req, 405, { ok: false, error: "unexpected_status_error" });
  }

  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) return json(req, admin.status, { ok: false, error: admin.error });

    const supabase = serviceClient();
    const connection = await loadActiveConnection(supabase);

    console.log("[microsoft-mailbox-status] status loaded", {
      phase: "connection_lookup",
      userId: admin.userId,
      connected: Boolean(connection),
      connectionId: connection?.id,
      status: connection?.status,
    });

    return json(req, 200, {
      ok: true,
      connected: Boolean(connection),
      connection,
    });
  } catch (error) {
    const safe = safeError(error);
    console.error("[microsoft-mailbox-status] failed", {
      phase: safe.phase,
      error: safe.code,
    });
    return json(req, safe.status, { ok: false, error: safe.code });
  }
});
