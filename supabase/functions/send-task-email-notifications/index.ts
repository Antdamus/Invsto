import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EmailRow = {
  id: string;
  to_email: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  attempts: number;
  meta: Record<string, unknown> | null;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value || !value.trim()) throw new Error(`missing_env:${name}`);
  return value.trim();
}

function cleanBaseUrl() {
  return optionalEnv("OG_APP_BASE_URL", "APP_BASE_URL", "SITE_URL", "PUBLIC_SITE_URL").replace(/\/+$/, "");
}

function materializeBody(value: string | null | undefined, appBaseUrl: string) {
  return String(value || "").replaceAll("{{APP_BASE_URL}}", appBaseUrl);
}

function retryDelayMs(attempts: number) {
  const minutes = Math.min(60, Math.max(2, Math.pow(2, Math.max(0, attempts - 1))));
  return minutes * 60 * 1000;
}

async function parseResponse(res: Response) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function sendWithResend(row: EmailRow, input: { apiKey: string; fromEmail: string; replyTo: string; appBaseUrl: string }) {
  const payload: Record<string, unknown> = {
    from: input.fromEmail,
    to: [row.to_email],
    subject: row.subject,
    text: materializeBody(row.text_body, input.appBaseUrl),
    headers: {
      "X-OG-Email-Outbox-ID": row.id,
    },
  };

  const html = materializeBody(row.html_body, input.appBaseUrl);
  if (html.trim()) payload.html = html;
  if (input.replyTo) payload.reply_to = input.replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await parseResponse(res);
  if (!res.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as Record<string, unknown>).message)
      : JSON.stringify(body);
    throw new Error(`resend_send_failed:${res.status}:${message}`);
  }

  return typeof body === "object" && body && "id" in body ? String((body as Record<string, unknown>).id) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRole = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = requiredEnv("RESEND_API_KEY");
    const fromEmail = optionalEnv("TASK_NOTIFICATION_FROM_EMAIL", "RESEND_FROM_EMAIL", "EMAIL_FROM");
    if (!fromEmail) throw new Error("missing_env:TASK_NOTIFICATION_FROM_EMAIL");

    const replyTo = optionalEnv("TASK_NOTIFICATION_REPLY_TO_EMAIL", "RESEND_REPLY_TO_EMAIL", "EMAIL_REPLY_TO");
    const appBaseUrl = cleanBaseUrl();
    const maxAttempts = Number(optionalEnv("TASK_EMAIL_MAX_ATTEMPTS")) || 4;

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const url = new URL(req.url);
    const rawBatch = Number(body.batch || body.limit || url.searchParams.get("batch") || 25);
    const batch = Math.max(1, Math.min(100, Number.isFinite(rawBatch) ? rawBatch : 25));

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase.rpc("email_outbox_claim", { _batch: batch });
    if (error) return json(500, { ok: false, error: "claim_failed", detail: error.message });

    const rows = (Array.isArray(data) ? data : []) as EmailRow[];
    const results: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      try {
        const providerMessageId = await sendWithResend(row, { apiKey, fromEmail, replyTo, appBaseUrl });
        const { error: updateError } = await supabase
          .from("email_outbox")
          .update({
            status: "sent",
            provider_message_id: providerMessageId,
            last_error: null,
            sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        if (updateError) throw new Error(`sent_update_failed:${updateError.message}`);
        results.push({ id: row.id, to_email: row.to_email, status: "sent", provider_message_id: providerMessageId });
      } catch (error) {
        const attempts = Number(row.attempts || 1);
        const exhausted = attempts >= maxAttempts;
        const nextStatus = exhausted ? "failed" : "pending";
        const sendAfter = exhausted ? new Date().toISOString() : new Date(Date.now() + retryDelayMs(attempts)).toISOString();
        const detail = error instanceof Error ? error.message : String(error);

        const { error: updateError } = await supabase
          .from("email_outbox")
          .update({
            status: nextStatus,
            last_error: detail.slice(0, 2000),
            send_after: sendAfter,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        results.push({
          id: row.id,
          to_email: row.to_email,
          status: nextStatus,
          error: detail,
          update_error: updateError?.message || null,
        });
      }
    }

    return json(200, {
      ok: true,
      claimed: rows.length,
      sent: results.filter((entry) => entry.status === "sent").length,
      failed: results.filter((entry) => entry.status === "failed").length,
      retrying: results.filter((entry) => entry.status === "pending").length,
      results,
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: "unexpected_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});
