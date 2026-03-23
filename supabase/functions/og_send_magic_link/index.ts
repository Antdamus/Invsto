/* =========================================================
   og_send_magic_link — OG Jewelers
   Bucketed rate limiting + magic link dispatch
   CORS FIXED: OPTIONS preflight + Access-Control-Allow-Origin
   Scaling: 1-minute buckets, 10-minute rolling window, 30s burst
   Neutral responses: no account enumeration

   DEBUG UPGRADE:
   - Always logs otp errors server-side (with request_id)
   - Optional debug response when payload.debug === true
   ========================================================= */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* -------------------------
   CORS
------------------------- */
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};

function json(status: number, body: Record<string, any>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getClientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

function cleanEmail(s: unknown) {
  return String(s ?? "").trim().toLowerCase();
}

function isValidEmail(email: string) {
  if (email.length < 5) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

function bucketEpoch(epochSec: number, sizeSec: number) {
  return Math.floor(epochSec / sizeSec) * sizeSec;
}

function requestId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

function safeErrorShape(err: any) {
  // Supabase errors typically have: message, status, code
  return {
    message: String(err?.message || "unknown_error"),
    code: err?.code ?? null,
    status: err?.status ?? null,
    name: err?.name ?? null,
  };
}

Deno.serve(async (req) => {
  const rid = requestId();

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("[og_send_magic_link]", rid, "server_not_configured");
    return json(500, { ok: false, error: "server_not_configured", request_id: rid });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json", request_id: rid });
  }

  const debug = payload?.debug === true; // <-- opt-in debug

  const email = cleanEmail(payload?.email);
  const redirectTo = String(payload?.redirectTo ?? "").trim();

  if (!isValidEmail(email)) return json(400, { ok: false, error: "invalid_email", request_id: rid });
  if (!redirectTo) return json(400, { ok: false, error: "missing_redirect", request_id: rid });

  const ipKey = getClientIp(req);
  const emailKey = email;
  const ua = req.headers.get("user-agent") || "";

  // Policy knobs
  const WINDOW_SEC = 10 * 60; // 10m rolling window
  const BUCKET_SEC = 60;      // 1m buckets
  const BURST_SEC = 30;       // 30s burst

  const MAX_IP_WINDOW = 10;   // per IP per 10m
  const MAX_EMAIL_WINDOW = 3; // per email per 10m
  const MAX_BURST = 2;        // per (ip,email) per 30s

  const t = nowEpochSec();
  const minuteBucket = bucketEpoch(t, BUCKET_SEC);
  const burstBucket = bucketEpoch(t, BURST_SEC);
  const windowCutoffBucket = bucketEpoch(t - WINDOW_SEC, BUCKET_SEC);

  // 1) Burst check (current 30s bucket)
  {
    const { data, error } = await sb
      .from("og_rl_burst_30s")
      .select("cnt")
      .eq("ip_key", ipKey)
      .eq("email_key", emailKey)
      .eq("bucket_epoch", burstBucket)
      .maybeSingle();

    if (error) {
      console.error("[og_send_magic_link]", rid, "rl_read_failed", safeErrorShape(error));
      return json(500, { ok: false, error: "rl_read_failed", request_id: rid });
    }

    const burstCnt = Number(data?.cnt ?? 0);
    if (burstCnt >= MAX_BURST) return json(429, { ok: false, blocked: true, request_id: rid });
  }

  // 2) 10m window checks (sum last 10 1m buckets)
  const [ipRows, emailRows] = await Promise.all([
    sb
      .from("og_rl_ip_minute")
      .select("cnt")
      .eq("ip_key", ipKey)
      .gte("bucket_epoch", windowCutoffBucket),
    sb
      .from("og_rl_email_minute")
      .select("cnt")
      .eq("email_key", emailKey)
      .gte("bucket_epoch", windowCutoffBucket),
  ]);

  if (ipRows.error || emailRows.error) {
    console.error("[og_send_magic_link]", rid, "rl_sum_failed", {
      ipErr: ipRows.error ? safeErrorShape(ipRows.error) : null,
      emailErr: emailRows.error ? safeErrorShape(emailRows.error) : null,
    });
    return json(500, { ok: false, error: "rl_sum_failed", request_id: rid });
  }

  const totalIp = (ipRows.data || []).reduce((a: number, r: any) => a + Number(r.cnt || 0), 0);
  const totalEmail = (emailRows.data || []).reduce((a: number, r: any) => a + Number(r.cnt || 0), 0);

  if (totalIp >= MAX_IP_WINDOW || totalEmail >= MAX_EMAIL_WINDOW) {
    return json(429, { ok: false, blocked: true, request_id: rid });
  }

  // 3) Increment counters (no overwrites, safe inserts)
  {
    const { error } = await sb
      .from("og_rl_burst_30s")
      .upsert(
        {
          ip_key: ipKey,
          email_key: emailKey,
          bucket_epoch: burstBucket,
          cnt: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "ip_key,email_key,bucket_epoch", ignoreDuplicates: true }
      );

    if (error) {
      console.error("[og_send_magic_link]", rid, "rl_write_failed(burst)", safeErrorShape(error));
      return json(500, { ok: false, error: "rl_write_failed", request_id: rid });
    }

    const { error: incErr } = await sb.rpc("increment_og_rl_burst_30s", {
      p_ip_key: ipKey,
      p_email_key: emailKey,
      p_bucket_epoch: burstBucket,
    });
    if (incErr) {
      console.error("[og_send_magic_link]", rid, "rl_inc_failed(burst)", safeErrorShape(incErr));
      return json(500, { ok: false, error: "rl_inc_failed", request_id: rid });
    }
  }

  {
    const { error } = await sb
      .from("og_rl_ip_minute")
      .upsert(
        {
          ip_key: ipKey,
          bucket_epoch: minuteBucket,
          cnt: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "ip_key,bucket_epoch", ignoreDuplicates: true }
      );

    if (error) {
      console.error("[og_send_magic_link]", rid, "rl_write_failed(ip)", safeErrorShape(error));
      return json(500, { ok: false, error: "rl_write_failed", request_id: rid });
    }

    const { error: incErr } = await sb.rpc("increment_og_rl_ip_minute", {
      p_ip_key: ipKey,
      p_bucket_epoch: minuteBucket,
    });
    if (incErr) {
      console.error("[og_send_magic_link]", rid, "rl_inc_failed(ip)", safeErrorShape(incErr));
      return json(500, { ok: false, error: "rl_inc_failed", request_id: rid });
    }
  }

  {
    const { error } = await sb
      .from("og_rl_email_minute")
      .upsert(
        {
          email_key: emailKey,
          bucket_epoch: minuteBucket,
          cnt: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "email_key,bucket_epoch", ignoreDuplicates: true }
      );

    if (error) {
      console.error("[og_send_magic_link]", rid, "rl_write_failed(email)", safeErrorShape(error));
      return json(500, { ok: false, error: "rl_write_failed", request_id: rid });
    }

    const { error: incErr } = await sb.rpc("increment_og_rl_email_minute", {
      p_email_key: emailKey,
      p_bucket_epoch: minuteBucket,
    });
    if (incErr) {
      console.error("[og_send_magic_link]", rid, "rl_inc_failed(email)", safeErrorShape(incErr));
      return json(500, { ok: false, error: "rl_inc_failed", request_id: rid });
    }
  }

  // 4) Send magic link (neutral response regardless of Auth outcome)
  const { error: otpErr } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  if (otpErr) {
    // Log full details server-side for debugging
    console.error("[og_send_magic_link]", rid, "otp_failed", {
      otp: safeErrorShape(otpErr),
      email,
      redirectTo,
      ipKey,
      ua,
    });

    // Neutral response to client (unless debug flag is set)
    return json(200, {
      ok: true,
      request_id: rid,
      ...(debug ? { debug: { otp_error: safeErrorShape(otpErr), redirectTo } } : {}),
    });
  }

  return json(200, { ok: true, request_id: rid, ...(debug ? { debug: { sent: true, redirectTo } } : {}) });
});
